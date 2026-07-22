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
          value: 'createitemfn-content'
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
          value: 'createitemfn-host'
        }
        {
          name: 'TABLE_NAME'
          value: ItemsTableName
        }
        {
          name: 'MONGO_URI'
          value: ItemsTableConnectionString
        }
        {
          name: 'DB_NAME'
          value: ItemsTableName
        }
      ]
    }
  }
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
          value: 'listitemsfn-content'
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
          value: 'listitemsfn-host'
        }
        {
          name: 'TABLE_NAME'
          value: ItemsTableName
        }
        {
          name: 'MONGO_URI'
          value: ItemsTableConnectionString
        }
        {
          name: 'DB_NAME'
          value: ItemsTableName
        }
      ]
    }
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