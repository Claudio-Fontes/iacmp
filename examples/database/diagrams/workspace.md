# Diagramas de Arquitetura — database

**Provider:** aws · **Region:** us-east-1

---

## Stack: database-stack

```mermaid
graph TD
  database_stack_VPC["🌐 VPC<br/>Network.VPC<br/>cidr: 10.0.0.0/16 · maxAzs: 3"]
  database_stack_Principal["🗄️ Principal<br/>Database.SQL<br/>engine: postgres · Multi-AZ · size: medium"]
  database_stack_Replica["🗄️ Replica<br/>Database.SQL<br/>engine: postgres · size: small"]

  database_stack_VPC -.->|inferred| database_stack_Principal
  database_stack_VPC -.->|inferred| database_stack_Replica
```

**Recursos:**

- 🌐 **VPC** `Network.VPC` — cidr: 10.0.0.0/16 · maxAzs: 3
- 🗄️ **Principal** `Database.SQL` — engine: postgres · Multi-AZ · size: medium
- 🗄️ **Replica** `Database.SQL` — engine: postgres · size: small

> Setas tracejadas indicam relações inferidas a partir da topologia da stack, não declaradas explicitamente no código.

---
