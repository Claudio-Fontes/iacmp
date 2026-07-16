param location string = resourceGroup().location
param CreateItemFnFqdn string
param ListItemsFnFqdn string

resource itemsApi 'Microsoft.ApiManagement/service@2023-05-01-preview' = {
  name: 'items-api-${uniqueString(resourceGroup().id)}'
  location: location
  sku: {
    name: 'Consumption'
    capacity: 0
  }
  tags: {
    Name: 'ItemsApi'
  }
  properties: {
    publisherEmail: 'admin@example.com'
    publisherName: 'ItemsApi'
    virtualNetworkType: 'None'
    customProperties: {
      'Microsoft.WindowsAzure.ApiManagement.Gateway.Security.Protocols.Tls10': 'false'
      'Microsoft.WindowsAzure.ApiManagement.Gateway.Security.Protocols.Tls11': 'false'
    }
  }
}

resource itemsApiApi 'Microsoft.ApiManagement/service/apis@2023-05-01-preview' = {
  parent: itemsApi
  name: 'main'
  properties: {
    displayName: 'items-api'
    path: 'api'
    protocols: [
      'https'
    ]
    subscriptionRequired: false
    serviceUrl: ''
  }
}

resource itemsApiApiPolicy 'Microsoft.ApiManagement/service/apis/policies@2023-05-01-preview' = {
  parent: itemsApiApi
  name: 'policy'
  properties: {
    value: '<policies><inbound><base /><cors allow-credentials="false"><allowed-origins><origin>*</origin></allowed-origins><allowed-methods preflight-result-max-age="300"><method>*</method></allowed-methods><allowed-headers><header>*</header></allowed-headers></cors></inbound><backend><base /></backend><outbound><base /></outbound><on-error><base /></on-error></policies>'
    format: 'xml'
  }
}

resource itemsApiBackendCreateItemFn 'Microsoft.ApiManagement/service/backends@2023-05-01-preview' = {
  parent: itemsApi
  name: 'backend-createitemfn'
  properties: {
    url: 'https://${CreateItemFnFqdn}/api/HttpTrigger'
    protocol: 'http'
    description: 'Function App backend for CreateItemFn'
  }
}

resource itemsApiBackendListItemsFn 'Microsoft.ApiManagement/service/backends@2023-05-01-preview' = {
  parent: itemsApi
  name: 'backend-listitemsfn'
  properties: {
    url: 'https://${ListItemsFnFqdn}/api/HttpTrigger'
    protocol: 'http'
    description: 'Function App backend for ListItemsFn'
  }
}

resource itemsApiOp0 'Microsoft.ApiManagement/service/apis/operations@2023-05-01-preview' = {
  parent: itemsApiApi
  name: 'op-post-0'
  properties: {
    displayName: 'POST /items'
    method: 'POST'
    urlTemplate: '/items'
    description: 'POST /items'
  }
}

resource itemsApiPolicy0 'Microsoft.ApiManagement/service/apis/operations/policies@2023-05-01-preview' = {
  parent: itemsApiOp0
  name: 'policy'
  dependsOn: [
    itemsApiBackendCreateItemFn
  ]
  properties: {
    value: '<policies><inbound><base /><set-backend-service backend-id="backend-createitemfn" /></inbound><backend><base /></backend><outbound><base /></outbound><on-error><base /></on-error></policies>'
    format: 'xml'
  }
}

resource itemsApiOp1 'Microsoft.ApiManagement/service/apis/operations@2023-05-01-preview' = {
  parent: itemsApiApi
  name: 'op-get-1'
  properties: {
    displayName: 'GET /items'
    method: 'GET'
    urlTemplate: '/items'
    description: 'GET /items'
  }
}

resource itemsApiPolicy1 'Microsoft.ApiManagement/service/apis/operations/policies@2023-05-01-preview' = {
  parent: itemsApiOp1
  name: 'policy'
  dependsOn: [
    itemsApiBackendListItemsFn
  ]
  properties: {
    value: '<policies><inbound><base /><set-backend-service backend-id="backend-listitemsfn" /></inbound><backend><base /></backend><outbound><base /></outbound><on-error><base /></on-error></policies>'
    format: 'xml'
  }
}

output ItemsApiUrl string = '${itemsApi.properties.gatewayUrl}/api'