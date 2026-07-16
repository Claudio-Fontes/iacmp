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

resource sharedFnStorageBlobSvc 'Microsoft.Storage/storageAccounts/blobServices@2023-01-01' = {
  parent: sharedFnStorage
  name: 'default'
  properties: {}
}

resource processorFnPlan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: 'processorfn-plan-${uniqueString(resourceGroup().id)}'
  location: location
  kind: 'functionapp'
  sku: {
    name: 'FC1'
    tier: 'FlexConsumption'
  }
  tags: {
    Name: 'ProcessorFn'
  }
  properties: {
    reserved: true
  }
}

resource processorFnDeployContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' = {
  parent: sharedFnStorageBlobSvc
  name: 'deploy-processorfn'
  properties: {}
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
  dependsOn: [
    processorFnDeployContainer
  ]
  properties: {
    serverFarmId: processorFnPlan.id
    functionAppConfig: {
      deployment: {
        storage: {
          type: 'blobContainer'
          value: '${sharedFnStorage.properties.primaryEndpoints.blob}deploy-processorfn'
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
      ]
    }
    httpsOnly: true
  }
}

resource processorFnStorageRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: sharedFnStorage
  name: guid(sharedFnStorage.id, processorFn.id, 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
    principalId: processorFn.identity.principalId
    principalType: 'ServicePrincipal'
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