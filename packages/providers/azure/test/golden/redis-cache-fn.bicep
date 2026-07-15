param location string = resourceGroup().location
param ProductCacheHost string = ''
param ProductCachePort string = ''
param ProductCacheConnectionString string = ''

resource sharedFnStorage 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: 'fn${uniqueString(resourceGroup().id)}'
  location: location
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  tags: {
    Stack: 'api-stack'
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

resource getProductFnPlan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: 'getproductfn-plan-${uniqueString(resourceGroup().id)}'
  location: location
  kind: 'functionapp'
  sku: {
    name: 'FC1'
    tier: 'FlexConsumption'
  }
  tags: {
    Name: 'GetProductFn'
  }
  properties: {
    reserved: true
  }
}

resource getProductFnDeployContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' = {
  parent: sharedFnStorageBlobSvc
  name: 'deploy-getproductfn'
  properties: {}
}

resource getProductFn 'Microsoft.Web/sites@2023-12-01' = {
  name: 'getproductfn-${uniqueString(resourceGroup().id)}'
  location: location
  kind: 'functionapp,linux'
  tags: {
    Name: 'GetProductFn'
  }
  identity: {
    type: 'SystemAssigned'
  }
  dependsOn: [
    getProductFnDeployContainer
  ]
  properties: {
    serverFarmId: getProductFnPlan.id
    functionAppConfig: {
      deployment: {
        storage: {
          type: 'blobContainer'
          value: '${sharedFnStorage.properties.primaryEndpoints.blob}deploy-getproductfn'
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
          name: 'REDIS_HOST'
          value: ProductCacheHost
        }
        {
          name: 'REDIS_PORT'
          value: ProductCachePort
        }
        {
          name: 'REDIS_CONNECTION_STRING'
          value: ProductCacheConnectionString
        }
      ]
    }
    httpsOnly: true
  }
}

resource getProductFnStorageRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: sharedFnStorage
  name: guid(sharedFnStorage.id, getProductFn.id, 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
    principalId: getProductFn.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

output getproductfnfunctionappname string = getProductFn.name
output GetProductFnId string = getProductFn.id
output GetProductFnPrincipalId string = getProductFn.identity.principalId
output GetProductFnFqdn string = getProductFn.properties.defaultHostName