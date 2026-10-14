---
name: aws-eks
description: Build and operate Amazon EKS securely - cluster endpoint access, access entries, EKS Pod Identity/IRSA, managed node groups/Karpenter/Auto Mode, add-ons, VPC CNI, AWS Load Balancer Controller, secrets encryption, logging, GuardDuty runtime, upgrades and troubleshooting. Use for any EKS cluster provisioning, upgrade, access, or node/pod networking issue.
---

# Amazon EKS

Load `cloud-guardrails` and use `kubernetes-ops` for in-cluster work. This skill covers the AWS side of the cluster.

## 1. Connect (read-only first)

```bash
aws eks list-clusters --profile P --region R
aws eks describe-cluster --name C --query "cluster.{v:version,status:status,endpointPublic:resourcesVpcConfig.endpointPublicAccess,publicCidrs:resourcesVpcConfig.publicAccessCidrs,private:resourcesVpcConfig.endpointPrivateAccess,auth:accessConfig.authenticationMode,logging:logging.clusterLogging}"
aws eks update-kubeconfig --name C --region R --profile P --alias eks-<env>-<region>   # writes kubeconfig; context alias must encode env
kubectl config current-context
```

## 2. Secure cluster baseline

| Area | Setting |
| --- | --- |
| API endpoint | Private access on; public access off, or restricted `publicAccessCidrs` (never `0.0.0.0/0` in prod) |
| Authentication | `authenticationMode = API` (access entries); no `aws-auth` ConfigMap edits; cluster creator admin disabled (`bootstrapClusterCreatorAdminPermissions = false`) and explicit access entries for platform roles |
| Human access | Access entries mapped to IAM Identity Center roles with access policies (`AmazonEKSClusterAdminPolicy` only for platform break-glass; `AmazonEKSViewPolicy`/namespace-scoped `AmazonEKSEditPolicy` for teams) |
| Workload identity | **EKS Pod Identity** (preferred) or IRSA; one role per service account; block pods from node role via IMDS hop limit 1 |
| Secrets | Envelope encryption with KMS (default for new clusters; verify `encryptionConfig`) + External Secrets / Secrets Store CSI |
| Logging | Control plane logs: `api`, `audit`, `authenticator` (minimum) to CloudWatch with retention |
| Nodes | Managed node groups / Karpenter / EKS Auto Mode; Bottlerocket or EKS-optimized AL2023; IMDSv2; encrypted volumes; no SSH keys; private subnets |
| Network | VPC CNI with prefix delegation; Network Policies (VPC CNI network policy agent, or Calico/Cilium); security groups for pods where needed |
| Ingress | AWS Load Balancer Controller (IRSA/Pod Identity), internal ALBs by default, WAF on internet-facing |
| Detection | GuardDuty EKS Protection + Runtime Monitoring; Inspector for ECR images |
| Policy | Pod Security Admission `restricted`; Kyverno/Gatekeeper (`policy-as-code`, `container-supply-chain`) |
| Upgrades | Stay within standard support; plan before extended support (extra cost) |

Terraform sketch (terraform-aws-modules/eks, pin the version):

```hcl
module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.24"
  cluster_name    = "eks-prod-use1"
  cluster_version = "1.31"
  cluster_endpoint_public_access  = false
  cluster_endpoint_private_access = true
  authentication_mode = "API"
  enable_cluster_creator_admin_permissions = false
  cluster_enabled_log_types = ["api", "audit", "authenticator", "controllerManager", "scheduler"]
  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnets
  cluster_addons = {
    vpc-cni                = { most_recent = true }
    coredns                = { most_recent = true }
    kube-proxy             = { most_recent = true }
    eks-pod-identity-agent = { most_recent = true }
    aws-ebs-csi-driver     = { most_recent = true, pod_identity_association = [{ role_arn = module.ebs_csi_role.arn, service_account = "ebs-csi-controller-sa" }] }
  }
  access_entries = { platform = { principal_arn = var.platform_admin_role_arn, policy_associations = { admin = { policy_arn = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy", access_scope = { type = "cluster" } } } } }
  tags = local.tags
}
```

Pin add-on versions explicitly in prod instead of `most_recent` once validated.

## 3. Pod Identity for a workload

```hcl
resource "aws_eks_pod_identity_association" "orders" {
  cluster_name    = module.eks.cluster_name
  namespace       = "orders"
  service_account = "orders-api"
  role_arn        = aws_iam_role.orders_api.arn   # trust: pods.eks.amazonaws.com, actions sts:AssumeRole + sts:TagSession
}
```

Scope the role's policy to that app's resources; use session tags (`kubernetes-namespace`, `kubernetes-service-account`) for ABAC.

## 4. Upgrades

1. Check insights: `aws eks list-insights --cluster-name C` (deprecated APIs, add-on compatibility).
2. Scan manifests for removed APIs (`pluto`, `kubent`).
3. Upgrade nonprod first. Control plane one minor version (`update-cluster-version` is a change; through IaC).
4. Upgrade add-ons to versions compatible with the new version (`aws eks describe-addon-versions --kubernetes-version 1.31 --addon-name vpc-cni`).
5. Roll nodes: managed node group update (respects PDBs, `max_unavailable`), Karpenter drift, or Auto Mode handles it.
6. Verify workloads, then prod in a window.

## 5. Troubleshooting

| Symptom | Check |
| --- | --- |
| `You must be logged in to the server (Unauthorized)` | Correct profile/role? Access entry exists for that principal? `aws eks list-access-entries --cluster-name C` |
| Pods `Pending` with no nodes | Karpenter/CA logs, node group scaling limits, subnet IP exhaustion (`AvailableIpAddressCount`), instance quotas |
| Pod IP exhaustion | VPC CNI `WARM_IP_TARGET`/prefix delegation, secondary CIDR for pods |
| Nodes `NotReady` | Node group health (`aws eks describe-nodegroup`), kubelet logs via SSM, CNI daemonset |
| AccessDenied from pod to AWS | Pod Identity association / IRSA annotation, SA name/namespace match, role trust, SDK version supports Pod Identity |
| LB not created | AWS LB Controller logs, subnet tags (`kubernetes.io/role/elb` / `internal-elb`), IAM for controller |
| `ImagePullBackOff` from ECR | Node role `AmazonEC2ContainerRegistryReadOnly`, ECR VPC endpoints, image exists in region |

## Never

- Open the API endpoint to `0.0.0.0/0` in prod, or re-enable `aws-auth` ConfigMap edits for convenience.
- Grant `AmazonEKSClusterAdminPolicy` / `cluster-admin` to apps or broad groups.
- Give node roles broad AWS permissions (S3, DynamoDB, Secrets): use Pod Identity per workload.
- Delete clusters (`eksctl delete cluster` is guard-blocked) or node groups in prod from the agent.
