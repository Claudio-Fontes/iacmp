param location string = resourceGroup().location

resource itemsTable 'Microsoft.DocumentDB/databaseAccounts@2023-04-15' = {
  name: 'itemstable-${uniqueString(resourceGroup().id)}'
  location: location
  kind: 'MongoDB'
  tags: {
    Name: 'ItemsTable'
  }
  properties: {
    databaseAccountOfferType: 'Standard'
    apiProperties: {
      serverVersion: '4.2'
    }
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

resource itemsTableDb 'Microsoft.DocumentDB/databaseAccounts/mongodbDatabases@2023-04-15' = {
  parent: itemsTable
  name: 'itemstable-db'
  properties: {
    resource: {
      id: 'itemstable-db'
    }
    options: {}
  }
}

resource itemsTableColl 'Microsoft.DocumentDB/databaseAccounts/mongodbDatabases/collections@2023-04-15' = {
  parent: itemsTableDb
  name: 'itemstable'
  properties: {
    resource: {
      id: 'itemstable'
    }
    options: {}
  }
}

output ItemsTableEndpoint string = itemsTable.properties.documentEndpoint
output ItemsTableName string = 'itemstable'
output ItemsTableArn string = itemsTable.id
#disable-next-line outputs-should-not-contain-secrets
output ItemsTableConnectionString string = itemsTable.listConnectionStrings().connectionStrings[0].connectionString