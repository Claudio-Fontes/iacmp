workspace "webapp" {

  model {
    webapp = softwareSystem "webapp" "Provider: aws, Region: us-east-1" {

      group "webapp-stack" {
        webapp_stack_Rede = container "Rede" "cidr: 10.0.0.0/16" "Virtual Network" {
          tags "Network"
        }
        webapp_stack_SiteBucket = container "SiteBucket" "versioning: off, public" "Object Storage" {
          tags "Storage"
        }
        webapp_stack_AssetsBucket = container "AssetsBucket" "versioning: on, private" "Object Storage" {
          tags "Storage"
        }
      }
    }
    webapp_stack_Rede -> webapp_stack_SiteBucket "[inferred]" "" "Inferred"
    webapp_stack_Rede -> webapp_stack_AssetsBucket "[inferred]" "" "Inferred"
  }

  views {

    container webapp "webapp_stackView" "webapp-stack" {
      include *
      autoLayout
    }

    styles {
      element "Compute" {
        background #1168bd
        color #ffffff
        shape RoundedBox
      }
      element "Storage" {
        background #f5a623
        color #ffffff
        shape Folder
      }
      element "Network" {
        background #6ab04c
        color #ffffff
        shape Hexagon
      }
      element "Database" {
        background #eb4d4b
        color #ffffff
        shape Cylinder
      }
      element "Function" {
        background #9b59b6
        color #ffffff
        shape Component
      }
      relationship "Inferred" {
        dashed true
        colour #999999
      }
    }
  }
}
