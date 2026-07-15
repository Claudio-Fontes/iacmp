param location string = resourceGroup().location
param ItemsTableName string = ''
param ItemsTableConnectionString string = ''

resource sharedFnStorage 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: 'fn${uniqueString(resourceGroup().id)}'
  location: location
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  tags: {
    Stack: 'crud-stack'
  }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
  }
}

resource sharedFnStorageBlobSvc 'Microsoft.Storage/storageAccounts/blobServices@2023-01-01' = {
  parent: sharedFnStorage
  name: 'default'
  properties: {}
}

resource createItemFnPlan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: 'createitemfn-plan-${uniqueString(resourceGroup().id)}'
  location: location
  kind: 'functionapp'
  sku: {
    name: 'FC1'
    tier: 'FlexConsumption'
  }
  tags: {
    Name: 'CreateItemFn'
  }
  properties: {
    reserved: true
  }
}

resource createItemFnDeployContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' = {
  parent: sharedFnStorageBlobSvc
  name: 'deploy-createitemfn'
  properties: {}
}

resource createItemFn 'Microsoft.Web/sites@2023-12-01' = {
  name: 'createitemfn-${uniqueString(resourceGroup().id)}'
  location: location
  kind: 'functionapp,linux'
  tags: {
    Name: 'CreateItemFn'
  }
  identity: {
    type: 'SystemAssigned'
  }
  dependsOn: [
    createItemFnDeployContainer
  ]
  properties: {
    serverFarmId: createItemFnPlan.id
    functionAppConfig: {
      deployment: {
        storage: {
          type: 'blobContainer'
          value: '${sharedFnStorage.properties.primaryEndpoints.blob}deploy-createitemfn'
          authentication: {
            type: 'SystemAssignedIdentity'
          }
        }
      }
      scaleAndConcurrency: {
        maximumInstanceCount: 100
        instanceMemoryMB: 2048
      }
      runtime: {
        name: 'node'
        version: '22'
      }
    }
    siteConfig: {
      appSettings: [
        {
          name: 'FUNCTIONS_EXTENSION_VERSION'
          value: '~4'
        }
        {
          name: 'AzureWebJobsStorage__accountName'
          value: sharedFnStorage.name
        }
        {
          name: 'TABLE_NAME'
          value: ItemsTableName
        }
        {
          name: 'TABLE_NAME_CONNECTION_STRING'
          value: ItemsTableConnectionString
        }
      ]
    }
    httpsOnly: true
  }
}

resource createItemFnStorageRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: sharedFnStorage
  name: guid(sharedFnStorage.id, createItemFn.id, 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
    principalId: createItemFn.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource listItemsFnPlan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: 'listitemsfn-plan-${uniqueString(resourceGroup().id)}'
  location: location
  kind: 'functionapp'
  sku: {
    name: 'FC1'
    tier: 'FlexConsumption'
  }
  tags: {
    Name: 'ListItemsFn'
  }
  properties: {
    reserved: true
  }
}

resource listItemsFnDeployContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' = {
  parent: sharedFnStorageBlobSvc
  name: 'deploy-listitemsfn'
  properties: {}
}

resource listItemsFn 'Microsoft.Web/sites@2023-12-01' = {
  name: 'listitemsfn-${uniqueString(resourceGroup().id)}'
  location: location
  kind: 'functionapp,linux'
  tags: {
    Name: 'ListItemsFn'
  }
  identity: {
    type: 'SystemAssigned'
  }
  dependsOn: [
    listItemsFnDeployContainer
  ]
  properties: {
    serverFarmId: listItemsFnPlan.id
    functionAppConfig: {
      deployment: {
        storage: {
          type: 'blobContainer'
          value: '${sharedFnStorage.properties.primaryEndpoints.blob}deploy-listitemsfn'
          authentication: {
            type: 'SystemAssignedIdentity'
          }
        }
      }
      scaleAndConcurrency: {
        maximumInstanceCount: 100
        instanceMemoryMB: 2048
      }
      runtime: {
        name: 'node'
        version: '22'
      }
    }
    siteConfig: {
      appSettings: [
        {
          name: 'FUNCTIONS_EXTENSION_VERSION'
          value: '~4'
        }
        {
          name: 'AzureWebJobsStorage__accountName'
          value: sharedFnStorage.name
        }
        {
          name: 'TABLE_NAME'
          value: ItemsTableName
        }
        {
          name: 'TABLE_NAME_CONNECTION_STRING'
          value: ItemsTableConnectionString
        }
      ]
    }
    httpsOnly: true
  }
}

resource listItemsFnStorageRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: sharedFnStorage
  name: guid(sharedFnStorage.id, listItemsFn.id, 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
    principalId: listItemsFn.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

output createitemfnfunctionappname string = createItemFn.name
output CreateItemFnId string = createItemFn.id
output CreateItemFnPrincipalId string = createItemFn.identity.principalId
output CreateItemFnFqdn string = createItemFn.properties.defaultHostName
output listitemsfnfunctionappname string = listItemsFn.name
output ListItemsFnId string = listItemsFn.id
output ListItemsFnPrincipalId string = listItemsFn.identity.principalId
output ListItemsFnFqdn string = listItemsFn.properties.defaultHostName