param location string = resourceGroup().location

resource mainVnet 'Microsoft.Network/virtualNetworks@2023-04-01' = {
  name: 'MainVnet'
  location: location
  tags: {
    Name: 'MainVnet'
  }
  properties: {
    addressSpace: {
      addressPrefixes: [
        '10.0.0.0/16'
      ]
    }
    dhcpOptions: {
      dnsServers: []
    }
    subnets: [
      {
        name: 'PrivateSubnet1'
        properties: {
          addressPrefix: '10.0.1.0/24'
          privateEndpointNetworkPolicies: 'Enabled'
        }
      }
      {
        name: 'PublicSubnet1'
        properties: {
          addressPrefix: '10.0.2.0/24'
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
    ]
  }
}

resource appSg 'Microsoft.Network/networkSecurityGroups@2023-04-01' = {
  name: 'AppSg'
  location: location
  tags: {
    Name: 'AppSg'
  }
  properties: {
    securityRules: [
      {
        name: 'ingress-rule-0'
        properties: {
          priority: 100
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourcePortRange: '*'
          destinationPortRange: '443'
          sourceAddressPrefix: '0.0.0.0/0'
          destinationAddressPrefix: '*'
          description: ''
        }
      }
    ]
  }
}
