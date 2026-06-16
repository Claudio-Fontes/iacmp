# Diagramas de Arquitetura — network

**Provider:** aws · **Region:** us-east-1

---

## Stack: network-stack

```mermaid
graph TD
  network_stack_VpcPrincipal["🌐 VpcPrincipal<br/>Network.VPC<br/>cidr: 10.0.0.0/8 · maxAzs: 3"]
  network_stack_Bastion["⚙️ Bastion<br/>Compute.Instance<br/>size: small · image: ubuntu-22.04"]
  network_stack_AppServer["⚙️ AppServer<br/>Compute.Instance<br/>size: large · image: ubuntu-22.04"]

  network_stack_VpcPrincipal -.->|inferred| network_stack_Bastion
  network_stack_VpcPrincipal -.->|inferred| network_stack_AppServer
```

**Recursos:**

- 🌐 **VpcPrincipal** `Network.VPC` — cidr: 10.0.0.0/8 · maxAzs: 3
- ⚙️ **Bastion** `Compute.Instance` — size: small · image: ubuntu-22.04
- ⚙️ **AppServer** `Compute.Instance` — size: large · image: ubuntu-22.04

> Setas tracejadas indicam relações inferidas a partir da topologia da stack, não declaradas explicitamente no código.

---
