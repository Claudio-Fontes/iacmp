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
  properties: {
    reserved: true
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'Node|20'
      appSettings: [
        {
          name: 'AzureWebJobsStorage'
          value: 'DefaultEndpointsProtocol=https;AccountName=${sharedFnStorage.name};AccountKey=${sharedFnStorage.listKeys().keys[0].value};EndpointSuffix=core.windows.net'
        }
        {
          name: 'WEBSITE_CONTENTAZUREFILECONNECTIONSTRING'
          value: 'DefaultEndpointsProtocol=https;AccountName=${sharedFnStorage.name};AccountKey=${sharedFnStorage.listKeys().keys[0].value};EndpointSuffix=core.windows.net'
        }
        {
          name: 'WEBSITE_CONTENTSHARE'
          value: 'listusersfn-content'
        }
        {
          name: 'FUNCTIONS_EXTENSION_VERSION'
          value: '~4'
        }
        {
          name: 'FUNCTIONS_WORKER_RUNTIME'
          value: 'node'
        }
        {
          name: 'AzureFunctionsWebHost__hostid'
          value: 'listusersfn-host'
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
  }
}

output listusersfnfunctionappname string = listUsersFn.name
output ListUsersFnId string = listUsersFn.id
output ListUsersFnPrincipalId string = listUsersFn.identity.principalId
output ListUsersFnFqdn string = listUsersFn.properties.defaultHostName