targetScope = 'resourceGroup'

@description('Select a region supporting Functions Flex Consumption and Cosmos DB serverless.')
param location string = 'centralus'
param prefix string = 'personalmemory'
@description('Exact token issuer. May be left empty for infrastructure bootstrap; configure before publishing/enabling the server.')
param authIssuer string = ''
@description('oidc: OAuth sign-in with one vault per identity. token: family tokens sharing one vault.')
@allowed(['oidc', 'token'])
param authMode string = 'oidc'
param authAudience string = ''
param authJwksUrl string = ''
param authorizationServer string = ''
param authRequestScope string = ''
@description('An existing Azure OpenAI account with the required deployments.')
param modelResourceName string
@description('Resource group containing the existing model account, in this subscription.')
param modelResourceGroup string = resourceGroup().name
param chatDeployment string = 'memory-reasoning'
param embeddingDeployment string = 'memory-embedding'
param embeddingVersion string = 'memory-embedding-v1'
var suffix = uniqueString(resourceGroup().id, prefix)
var appName = '${prefix}-${suffix}'
var storageName = take('memory${suffix}', 24)
var cosmosName = '${prefix}-cosmos-${suffix}'

resource network 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: '${prefix}-vnet'
  location: location
  properties: {
    addressSpace: { addressPrefixes: ['10.40.0.0/16'] }
    subnets: [
      { name: 'functions', properties: { addressPrefix: '10.40.1.0/24', delegations: [{ name: 'functions', properties: { serviceName: 'Microsoft.App/environments' } }] } }
      { name: 'private-endpoints', properties: { addressPrefix: '10.40.2.0/24', privateEndpointNetworkPolicies: 'Disabled' } }
    ]
  }
}
resource dns 'Microsoft.Network/privateDnsZones@2024-06-01' = { name: 'privatelink.documents.azure.com', location: 'global' }
resource dnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: dns
  name: 'memory-network'
  location: 'global'
  properties: { registrationEnabled: false, virtualNetwork: { id: network.id } }
}
resource cosmos 'Microsoft.DocumentDB/databaseAccounts@2024-11-15' = {
  name: cosmosName
  location: location
  kind: 'GlobalDocumentDB'
  properties: {
    databaseAccountOfferType: 'Standard'
    capabilities: [{ name: 'EnableServerless' }, { name: 'EnableNoSQLVectorSearch' }]
    consistencyPolicy: { defaultConsistencyLevel: 'Strong' }
    locations: [{ locationName: location, failoverPriority: 0, isZoneRedundant: false }]
    publicNetworkAccess: 'Disabled'
    disableLocalAuth: true
    minimalTlsVersion: 'Tls12'
    backupPolicy: { type: 'Continuous', continuousModeProperties: { tier: 'Continuous7Days' } }
  }
}
resource database 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-11-15' = {
  parent: cosmos
  name: 'memory'
  properties: { resource: { id: 'memory' }, options: {} }
}
resource vaults 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: database
  name: 'vaults'
  properties: {
    resource: {
      id: 'vaults'
      partitionKey: { paths: ['/vault_id'], kind: 'Hash', version: 2 }
      indexingPolicy: {
        indexingMode: 'consistent'
        automatic: true
        includedPaths: [{ path: '/*' }]
        excludedPaths: [{ path: '/embedding/*' }, { path: '/payload/?' }, { path: '/data/payload_gzip/?' }]
        vectorIndexes: [{ path: '/embedding', type: 'diskANN' }]
      }
      vectorEmbeddingPolicy: { vectorEmbeddings: [{ path: '/embedding', dataType: 'float32', dimensions: 1536, distanceFunction: 'cosine' }] }
    }
    options: {}
  }
}
resource identities 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = {
  parent: database
  name: 'identities'
  properties: { resource: { id: 'identities', partitionKey: { paths: ['/id'], kind: 'Hash', version: 2 } }, options: {} }
}
resource endpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: '${prefix}-cosmos-private'
  location: location
  properties: {
    subnet: { id: '${network.id}/subnets/private-endpoints' }
    privateLinkServiceConnections: [{ name: 'cosmos', properties: { privateLinkServiceId: cosmos.id, groupIds: ['Sql'] } }]
  }
}
resource endpointDns 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: endpoint
  name: 'default'
  properties: { privateDnsZoneConfigs: [{ name: 'cosmos', properties: { privateDnsZoneId: dns.id } }] }
  dependsOn: [dnsLink]
}
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: { minimumTlsVersion: 'TLS1_2', allowBlobPublicAccess: false, allowSharedKeyAccess: false }
}
resource blobs 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = { parent: storage, name: 'default' }
resource deployments 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobs
  name: 'deployments'
  properties: { publicAccess: 'None' }
}
resource plan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: '${prefix}-plan'
  location: location
  kind: 'functionapp'
  sku: { name: 'FC1', tier: 'FlexConsumption' }
  properties: { reserved: true }
}
resource app 'Microsoft.Web/sites@2024-04-01' = {
  name: appName
  location: location
  kind: 'functionapp,linux'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    virtualNetworkSubnetId: '${network.id}/subnets/functions'
    functionAppConfig: {
      deployment: {
        storage: {
          type: 'blobContainer'
          value: '${storage.properties.primaryEndpoints.blob}${deployments.name}'
          authentication: { type: 'SystemAssignedIdentity' }
        }
      }
      runtime: { name: 'node', version: '22' }
      scaleAndConcurrency: { instanceMemoryMB: 2048, maximumInstanceCount: 40 }
    }

  }
}
resource appSettings 'Microsoft.Web/sites/config@2024-04-01' = {
  parent: app
  name: 'appsettings'
  properties: {
    AzureWebJobsStorage__accountName: storage.name
    AzureWebJobsStorage__credential: 'managedidentity'
    AzureWebJobsFeatureFlags: 'EnableMcpCustomHandlerPreview'
    AzureFunctionsJobHost__customHandler__http__DefaultAuthorizationLevel: 'anonymous'
    NODE_ENV: 'production'
    SERVING_ENABLED: 'false'
    PORT: '3000'
    PUBLIC_URL: 'https://${app.properties.defaultHostName}'
    COSMOS_ENDPOINT: cosmos.properties.documentEndpoint
    COSMOS_DATABASE: database.name
    COSMOS_CONTAINER: vaults.name
    COSMOS_DIRECTORY_CONTAINER: identities.name
    AUTH_MODE: authMode
    AUTH_ISSUER: authIssuer
    AUTH_AUDIENCE: authAudience
    AUTH_JWKS_URL: authJwksUrl
    AUTHORIZATION_SERVER: authorizationServer
    AUTH_SCOPE: 'memory.access'
    AUTH_REQUEST_SCOPE: authRequestScope
    AZURE_OPENAI_ENDPOINT: 'https://${modelResourceName}.openai.azure.com'
    AZURE_OPENAI_CHAT_DEPLOYMENT: chatDeployment
    AZURE_OPENAI_EMBEDDING_DEPLOYMENT: embeddingDeployment
    EMBEDDING_VERSION: embeddingVersion
  }
}

resource storageRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storage
  name: guid(storage.id, app.id, 'blob-owner')
  properties: { principalId: app.identity.principalId, principalType: 'ServicePrincipal', roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b') }
}
resource vaultRole 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-11-15' = {
  parent: cosmos
  name: guid(cosmos.id, app.id, 'vault-contributor')
  properties: {
    principalId: app.identity.principalId
    roleDefinitionId: '${cosmos.id}/sqlRoleDefinitions/00000000-0000-0000-0000-000000000002'
    scope: '${cosmos.id}/dbs/${database.name}/colls/${vaults.name}'
  }
}
resource directoryRole 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-11-15' = {
  parent: cosmos
  name: guid(cosmos.id, app.id, 'identity-reader')
  properties: {
    principalId: app.identity.principalId
    roleDefinitionId: '${cosmos.id}/sqlRoleDefinitions/00000000-0000-0000-0000-000000000001'
    scope: '${cosmos.id}/dbs/${database.name}/colls/${identities.name}'
  }
}
module modelAccess './model-access.bicep' = {
  name: 'memory-model-access-${suffix}'
  scope: resourceGroup(modelResourceGroup)
  params: {
    modelResourceName: modelResourceName
    functionAppId: app.id
    principalId: app.identity.principalId
  }
}

output functionAppName string = app.name
output mcpUrl string = 'https://${app.properties.defaultHostName}/mcp'
output cosmosEndpoint string = cosmos.properties.documentEndpoint
output cosmosAccountName string = cosmos.name
output databaseName string = database.name
output subnetForAdminRunner string = '${network.id}/subnets/functions'
