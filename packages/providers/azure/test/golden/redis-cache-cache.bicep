param location string = resourceGroup().location

resource productCache 'Microsoft.Cache/redis@2023-04-01' = {
  name: 'productcache-${uniqueString(resourceGroup().id)}'
  location: location
  sku: {
    name: 'Basic'
    family: 'C'
    capacity: 0
  }
  tags: {
    Name: 'ProductCache'
  }
  properties: {
    enableNonSslPort: false
    minimumTlsVersion: '1.2'
    redisConfiguration: {}
  }
}

output ProductCacheEndpoint string = productCache.properties.hostName
output ProductCachePort string = '6380'
output ProductCacheHost string = productCache.properties.hostName
#disable-next-line outputs-should-not-contain-secrets
output ProductCacheConnectionString string = 'rediss://:${productCache.listKeys().primaryKey}@${productCache.properties.hostName}:6380'