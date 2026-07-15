param location string = resourceGroup().location

resource itemsTable 'Microsoft.DocumentDB/databaseAccounts@2023-04-15' = {
  name: 'itemstable-${uniqueString(resourceGroup().id)}'
  location: location
  kind: 'GlobalDocumentDB'
  tags: {
    Name: 'ItemsTable'
  }
  properties: {
    databaseAccountOfferType: 'Standard'
    capabilities: [
      {
        name: 'EnableTable'
      }
    ]
    locations: [
      {
        locationName: location
        failoverPriority: 0
        isZoneRedundant: false
      }
    ]
    backupPolicy: {
      type: 'Periodic'
      periodicModeProperties: {
        backupIntervalInMinutes: 1440
        backupRetentionIntervalInHours: 168
      }
    }
  }
}

resource itemsTableTable 'Microsoft.DocumentDB/databaseAccounts/tables@2023-04-15' = {
  parent: itemsTable
  name: 'ItemsTable'
  properties: {
    resource: {
      id: 'ItemsTable'
    }
    options: {}
  }
}

output ItemsTableEndpoint string = itemsTable.properties.documentEndpoint
output ItemsTableName string = 'ItemsTable'
output ItemsTableArn string = itemsTable.id
output ItemsTableConnectionString string = 'DefaultEndpointsProtocol=https;AccountName=${itemsTable.name};AccountKey=${itemsTable.listKeys().primaryMasterKey};TableEndpoint=https://${itemsTable.name}.table.cosmos.azure.com:443/;'