workspace "database" {

  model {
    database = softwareSystem "database" "Provider: aws · Region: us-east-1" {

      group "database-stack" {
        database_stack_VPC = container "VPC" "Virtual Network" "cidr: 10.0.0.0/16 · maxAzs: 3" {
          tags "Network"
        }
        database_stack_Principal = container "Principal" "Relational DB" "engine: postgres · Multi-AZ · size: medium" {
          tags "Database"
        }
        database_stack_Replica = container "Replica" "Relational DB" "engine: postgres · size: small" {
          tags "Database"
        }
      }
    }
    database_stack_VPC -> database_stack_Principal "[inferred]" "" "Inferred"
    database_stack_VPC -> database_stack_Replica "[inferred]" "" "Inferred"
  }

  views {

    container database "database_stackView" "database-stack" {
      include *
      autoLayout
    }

    styles {
      element "Compute"  { background #1168bd; color #ffffff; shape RoundedBox }
      element "Storage"  { background #f5a623; color #ffffff; shape Folder }
      element "Network"  { background #6ab04c; color #ffffff; shape Hexagon }
      element "Database" { background #eb4d4b; color #ffffff; shape Cylinder }
      element "Function" { background #9b59b6; color #ffffff; shape Component }
      relationship "Inferred" { style dashed; color #999999 }
    }
  }
}
