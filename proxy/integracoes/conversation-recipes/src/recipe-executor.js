import jsonpointer from 'jsonpointer';

export function resolveBindings(recipe, completedNodesData) {
  const resolvedParameters = { ...recipe.inputs };

  for (const binding of recipe.bindings) {
    const sourceNodeData = completedNodesData[binding.from];
    if (!sourceNodeData) continue; 

    try {
      const extractedValue = jsonpointer.get(sourceNodeData, binding.pointer);
      
      if (extractedValue !== undefined) {
        const [targetNode, paramName] = binding.to.split('.');
        if (!resolvedParameters[targetNode]) {
          resolvedParameters[targetNode] = {};
        }
        resolvedParameters[targetNode][paramName] = extractedValue;
      }
    } catch (e) {
      console.warn(`Binding falhou: de ${binding.from}${binding.pointer} para ${binding.to}`, e);
    }
  }

  return resolvedParameters;
}

export function prepareNextExecutionPlan(recipe, resolvedParameters) {
  const planNodes = [];
  
  for (const node of recipe.nodes) {
    const nodeInputs = resolvedParameters[node.id];
    if (nodeInputs || Object.keys(resolvedParameters).length === 0) {
      planNodes.push({
        capabilityRef: node.capabilityRef,
        arguments: nodeInputs || {}
      });
    }
  }
  
  return {
    recipeId: recipe.id,
    planNodes,
    status: 'awaiting_approval'
  };
}
