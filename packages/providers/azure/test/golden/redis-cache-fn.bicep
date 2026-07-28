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
          value: 'getproductfn-content'
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
          value: 'getproductfn-host'
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
  }
}

output getproductfnfunctionappname string = getProductFn.name
output GetProductFnId string = getProductFn.id
output GetProductFnPrincipalId string = getProductFn.identity.principalId
output GetProductFnFqdn string = getProductFn.properties.defaultHostName