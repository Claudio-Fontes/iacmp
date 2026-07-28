import type { CloudFormationTemplate, CloudFormationResource } from '../types';
import type { StackGraph } from '../graph';
import { isResourceRef, isImportRef, isSubRef } from '../graph';

function convertValue(v: unknown): unknown {
  if (isResourceRef(v)) {
    return v.attribute === 'Id'
      ? { Ref: v.targetLogicalId }
      : { 'Fn::GetAtt': [v.targetLogicalId, v.attribute] };
  }
  if (isImportRef(v)) {
    return { 'Fn::ImportValue': v.exportName };
  }
  if (isSubRef(v)) {
    const entries = Object.entries(v.vars);
    if (entries.length === 0) return { 'Fn::Sub': v.template };
    const cvars: Record<string, unknown> = {};
    for (const [k, val] of entries) {
      cvars[k] = typeof val === 'string' ? val : convertValue(val);
    }
    return { 'Fn::Sub': [v.template, cvars] };
  }
  if (Array.isArray(v)) return v.map(convertValue);
  if (typeof v === 'object' && v !== null) {
    const result: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      result[k] = convertValue(val);
    }
    return result;
  }
  return v;
}

export function emitCloudFormation(graph: StackGraph): CloudFormationTemplate {
  const resources: Record<string, CloudFormationResource> = {};
  const outputs: Record<string, { Value: unknown; Export: { Name: string } }> = {};

  for (const node of graph.nodes) {
    resources[node.logicalId] = {
      Type: node.awsType,
      ...(node.deletionPolicy ? { DeletionPolicy: node.deletionPolicy } : {}),
      ...(node.dependsOn.length > 0 ? { DependsOn: node.dependsOn } : {}),
      Properties: convertValue(node.properties) as Record<string, unknown>,
    };
  }

  for (const exp of graph.exports) {
    outputs[exp.key] = {
      Value: convertValue(exp.value),
      Export: { Name: exp.name },
    };
  }

  const template: CloudFormationTemplate = {
    AWSTemplateFormatVersion: '2010-09-09',
    Description: `Stack ${graph.stackName} — gerada pelo iacmp`,
    Resources: resources,
  };
  if (Object.keys(outputs).length > 0) template.Outputs = outputs;
  return template;
}
