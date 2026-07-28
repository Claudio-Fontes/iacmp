param location string = resourceGroup().location
@secure()
param adminPassword string

resource appDB 'Microsoft.DBforPostgreSQL/flexibleServers@2023-06-01-preview' = {
  name: 'appdb-server'
  location: location
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  tags: {
    Name: 'AppDB'
  }
  properties: {
    administratorLogin: 'dbadmin'
    administratorLoginPassword: adminPassword
    version: '15'
    storage: {
      storageSizeGB: 32
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
  }
}

resource appDBFw 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2023-06-01-preview' = {
  parent: appDB
  name: 'AllowAzure'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

output AppDBEndpoint string = appDB.properties.fullyQualifiedDomainName
output AppDBPort string = '5432'
output AppDBUsername string = 'dbadmin'