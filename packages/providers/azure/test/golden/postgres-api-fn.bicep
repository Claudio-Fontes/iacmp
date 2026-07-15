param location string = resourceGroup().location
@secure()
param adminPassword string
param AppDBEndpoint string = ''
param AppDBPort string = ''
param AppDBUsername string = ''

resource sharedFnStorage 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: 'fn${uniqueString(resourceGroup().id)}'
  location: location
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  tags: {
    Stack: 'lambda-stack'
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

resource listUsersFnPlan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: 'listusersfn-plan-${uniqueString(resourceGroup().id)}'
  location: location
  kind: 'functionapp'
  sku: {
    name: 'FC1'
    tier: 'FlexConsumption'
  }
  tags: {
    Name: 'ListUsersFn'
  }
  properties: {
    reserved: true
  }
}

resource listUsersFnDeployContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' = {
  parent: sharedFnStorageBlobSvc
  name: 'deploy-listusersfn'
  properties: {}
}

resource listUsersFn 'Microsoft.Web/sites@2023-12-01' = {
  name: 'listusersfn-${uniqueString(resourceGroup().id)}'
  location: location
  kind: 'functionapp,linux'
  tags: {
    Name: 'ListUsersFn'
  }
  identity: {
    type: 'SystemAssigned'
  }
  dependsOn: [
    listUsersFnDeployContainer
  ]
  properties: {
    serverFarmId: listUsersFnPlan.id
    functionAppConfig: {
      deployment: {
        storage: {
          type: 'blobContainer'
          value: '${sharedFnStorage.properties.primaryEndpoints.blob}deploy-listusersfn'
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
          name: 'DB_HOST'
          value: AppDBEndpoint
        }
        {
          name: 'DB_PORT'
          value: AppDBPort
        }
        {
          name: 'DB_USER'
          value: AppDBUsername
        }
        {
          name: 'DB_PASSWORD'
          value: adminPassword
        }
        {
          name: 'DB_NAME'
          value: 'postgres'
        }
      ]
    }
    httpsOnly: true
  }
}

resource listUsersFnStorageRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: sharedFnStorage
  name: guid(sharedFnStorage.id, listUsersFn.id, 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
    principalId: listUsersFn.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

output listusersfnfunctionappname string = listUsersFn.name
output ListUsersFnId string = listUsersFn.id
output ListUsersFnPrincipalId string = listUsersFn.identity.principalId
output ListUsersFnFqdn string = listUsersFn.properties.defaultHostName