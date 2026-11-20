targetScope = 'resourceGroup'

param modelResourceName string
param functionAppId string
param principalId string

resource models 'Microsoft.CognitiveServices/accounts@2024-10-01' existing = {
  name: modelResourceName
}
resource modelRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: models
  name: guid(models.id, functionAppId, 'openai-user')
  properties: {
    principalId: principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd')
  }
}
