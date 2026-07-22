param location string = resourceGroup().location

resource productCache 'Microsoft.Cache/redisEnterprise@2025-07-01' = {
  name: 'productcache-${uniqueString(resourceGroup().id)}'
  location: location
  sku: {
    name: 'Balanced_B0'
  }
  tags: {
    Name: 'ProductCache'
  }
  properties: {
    minimumTlsVersion: '1.2'
    publicNetworkAccess: 'Enabled'
    highAvailability: 'Disabled'
  }
}

resource productCacheDb 'Microsoft.Cache/redisEnterprise/databases@2025-07-01' = {
  parent: productCache
  name: 'default'
  properties: {
    clientProtocol: 'Encrypted'
    clusteringPolicy: 'NoCluster'
    evictionPolicy: 'VolatileLRU'
    port: 10000
  }
}

output ProductCacheEndpoint string = productCache.properties.hostName
output ProductCachePort string = '10000'
output ProductCacheHost string = productCache.properties.hostName
#disable-next-line outputs-should-not-contain-secrets
output ProductCacheConnectionString string = 'rediss://:${productCacheDb.listKeys().primaryKey}@${productCache.properties.hostName}:10000'