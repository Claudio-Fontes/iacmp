param location string = resourceGroup().location

resource sharedFnStorage 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: 'fn${uniqueString(resourceGroup().id)}'
  location: location
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  tags: {
    Stack: 'pipeline-stack'
  }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
  }
}

resource processorFn 'Microsoft.Web/sites@2023-12-01' = {
  name: 'processorfn-${uniqueString(resourceGroup().id)}'
  location: location
  kind: 'functionapp,linux'
  tags: {
    Name: 'ProcessorFn'
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
          value: 'processorfn-content'
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
          value: 'processorfn-host'
        }
      ]
    }
  }
}

resource rawDataBucket 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: 'rawdatabuck${uniqueString(resourceGroup().id)}'
  location: location
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  tags: {
    Name: 'RawDataBucket'
  }
  properties: {
    allowBlobPublicAccess: false
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
  }
}

resource rawDataBucketEventTopic 'Microsoft.EventGrid/systemTopics@2022-06-15' = {
  name: 'rawdatabucket-evttopic'
  location: location
  tags: {
    Name: 'RawDataBucket'
  }
  properties: {
    source: rawDataBucket.id
    topicType: 'Microsoft.Storage.StorageAccounts'
  }
}

resource rawDataBucketEventTopicSub0 'Microsoft.EventGrid/systemTopics/eventSubscriptions@2022-06-15' = {
  parent: rawDataBucketEventTopic
  name: 'blob-created-0'
  dependsOn: [
    processorFn
  ]
  properties: {
    eventDeliverySchema: 'EventGridSchema'
    destination: {
      endpointType: 'WebHook'
      properties: {
        endpointUrl: 'https://${processorFn.properties.defaultHostName}/events'
      }
    }
    filter: {
      includedEventTypes: [
        'Microsoft.Storage.BlobCreated'
      ]
    }
  }
}

output processorfnfunctionappname string = processorFn.name
output ProcessorFnId string = processorFn.id
output ProcessorFnPrincipalId string = processorFn.identity.principalId
output ProcessorFnFqdn string = processorFn.properties.defaultHostName
output RawDataBucketId string = rawDataBucket.id
output RawDataBucketName string = rawDataBucket.name
#disable-next-line outputs-should-not-contain-secrets
output RawDataBucketConnectionString string = 'DefaultEndpointsProtocol=https;AccountName=${rawDataBucket.name};AccountKey=${rawDataBucket.listKeys().keys[0].value};EndpointSuffix=core.windows.net'