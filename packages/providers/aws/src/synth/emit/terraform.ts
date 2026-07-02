import type { CloudFormationTemplate, CloudFormationResource } from '../types';
import { toSnake, getOrFallbackTFMapping } from './terraform-mapping';

function toTFId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
}

function sanitizeVarName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
}

interface EmitCtx {
  resources: Record<string, CloudFormationResource>;
  usedDataSources: Set<string>;
  importVars: Map<string, string>;
}

function resolveRef(logicalId: string, attribute: string, ctx: EmitCtx): string {
  const node = ctx.resources[logicalId];
  if (!node) return `UNRESOLVED_${logicalId}`;

  const mapping = getOrFallbackTFMapping(node.Type);
  const tfId = toTFId(logicalId);
  const tfType = mapping.tfType;

  let tfAttr: string;
  if (attribute === 'Id') {
    tfAttr = mapping.refAttr;
  } else if (mapping.attrMap[attribute]) {
    tfAttr = mapping.attrMap[attribute];
  } else {
    tfAttr = toSnake(attribute).replace(/\./g, '_');
  }

  return `\${${tfType}.${tfId}.${tfAttr}}`;
}

function resolveSubTemplate(
  template: string,
  vars: Record<string, unknown>,
  ctx: EmitCtx,
): string {
  return template.replace(/\$\{([^}]+)\}/g, (_match, token: string) => {
    if (token in vars) {
      const val = vars[token];
      if (typeof val === 'string') return val;
      return String(val ?? '');
    }
    if (token === 'AWS::Region') {
      ctx.usedDataSources.add('aws_region');
      return '${data.aws_region.current.name}';
    }
    if (token === 'AWS::AccountId') {
      ctx.usedDataSources.add('aws_caller_identity');
      return '${data.aws_caller_identity.current.account_id}';
    }
    if (token === 'AWS::StackName') {
      return 'iacmp';
    }
    if (token === 'AWS::Partition') {
      return 'aws';
    }
    const dotIdx = token.indexOf('.');
    if (dotIdx > 0) {
      const id = token.slice(0, dotIdx);
      const attr = token.slice(dotIdx + 1);
      return resolveRef(id, attr, ctx);
    }
    return resolveRef(token, 'Id', ctx);
  });
}

function resolveValue(v: unknown, ctx: EmitCtx): unknown {
  if (v === null || v === undefined) return v;

  if (Array.isArray(v)) {
    return v.map((item) => resolveValue(item, ctx));
  }

  if (typeof v === 'object') {
    const obj = v as Record<string, unknown>;

    // Raw CFN intrinsics
    if ('Ref' in obj && Object.keys(obj).length === 1) {
      const ref = obj['Ref'] as string;
      if (ref === 'AWS::Region') {
        ctx.usedDataSources.add('aws_region');
        return '${data.aws_region.current.name}';
      }
      if (ref === 'AWS::AccountId') {
        ctx.usedDataSources.add('aws_caller_identity');
        return '${data.aws_caller_identity.current.account_id}';
      }
      if (ref === 'AWS::StackName') return 'iacmp';
      if (ref === 'AWS::Partition') return 'aws';
      if (ref === 'AWS::NoValue') return undefined;
      return resolveRef(ref, 'Id', ctx);
    }

    if ('Fn::GetAtt' in obj && Object.keys(obj).length === 1) {
      const [id, attr] = obj['Fn::GetAtt'] as [string, string];
      return resolveRef(id, attr, ctx);
    }

    if ('Fn::ImportValue' in obj && Object.keys(obj).length === 1) {
      const name = obj['Fn::ImportValue'] as string;
      const varName = sanitizeVarName(name);
      ctx.importVars.set(varName, name);
      return `\${var.${varName}}`;
    }

    if ('Fn::Sub' in obj && Object.keys(obj).length === 1) {
      const sub = obj['Fn::Sub'];
      if (typeof sub === 'string') {
        return resolveSubTemplate(sub, {}, ctx);
      }
      if (Array.isArray(sub)) {
        const [template, rawVars] = sub as [string, Record<string, unknown>];
        const resolvedVars: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(rawVars ?? {})) {
          resolvedVars[k] = resolveValue(val, ctx);
        }
        return resolveSubTemplate(template, resolvedVars, ctx);
      }
    }

    if ('Fn::Join' in obj && Object.keys(obj).length === 1) {
      const [delim, parts] = obj['Fn::Join'] as [string, unknown[]];
      const resolved = (parts ?? []).map((p) => resolveValue(p, ctx));
      return resolved.join(delim);
    }

    if ('Fn::Select' in obj && Object.keys(obj).length === 1) {
      const [idx, arr] = obj['Fn::Select'] as [number, unknown[]];
      const resolved = resolveValue(arr, ctx);
      if (Array.isArray(resolved)) return resolved[idx];
      return resolved;
    }

    if ('Fn::If' in obj && Object.keys(obj).length === 1) {
      // Can't resolve conditions in TF; return the truthy branch
      const [, ifTrue] = obj['Fn::If'] as [string, unknown, unknown];
      return resolveValue(ifTrue, ctx);
    }

    // Regular object — recurse
    const result: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(obj)) {
      const resolved = resolveValue(val, ctx);
      if (resolved !== undefined) result[k] = resolved;
    }
    return result;
  }

  return v;
}

export function emitTerraform(template: CloudFormationTemplate): Record<string, unknown> {
  const ctx: EmitCtx = {
    resources: template.Resources,
    usedDataSources: new Set(),
    importVars: new Map(),
  };

  const tfResources: Record<string, Record<string, unknown>> = {};
  const tfOutputs: Record<string, unknown> = {};
  // Sidecar data sources (e.g. archive_file for Lambda local code)
  const tfData: Record<string, Record<string, unknown>> = {};
  let needsArchiveProvider = false;

  for (const [logicalId, resource] of Object.entries(template.Resources)) {
    const mapping = getOrFallbackTFMapping(resource.Type);
    const tfId = toTFId(logicalId);

    const resolvedProps = mapping.mapProps(
      resource.Properties,
      (v) => resolveValue(v, ctx),
      logicalId,
      (refId) => ctx.resources[refId],
    );

    if (resource.DependsOn && resource.DependsOn.length > 0) {
      const deps = resource.DependsOn.map((d) => {
        const dep = ctx.resources[d];
        if (!dep) return d;
        const m = getOrFallbackTFMapping(dep.Type);
        return `${m.tfType}.${toTFId(d)}`;
      });
      resolvedProps['depends_on'] = deps;
    }

    if (resource.DeletionPolicy === 'Retain') {
      resolvedProps['lifecycle'] = { prevent_destroy: true };
    }

    if (!tfResources[mapping.tfType]) {
      tfResources[mapping.tfType] = {};
    }
    tfResources[mapping.tfType][tfId] = resolvedProps;

    // Handle sidecars: additional TF resources and data sources from one CFN resource
    if (mapping.sidecars) {
      const sc = mapping.sidecars(logicalId, resource.Properties, (v) => resolveValue(v, ctx));
      for (const sr of sc.resources ?? []) {
        if (!tfResources[sr.tfType]) tfResources[sr.tfType] = {};
        tfResources[sr.tfType][sr.tfId] = sr.props;
      }
      for (const ds of sc.dataSources ?? []) {
        if (!tfData[ds.dsType]) tfData[ds.dsType] = {};
        tfData[ds.dsType][ds.dsId] = ds.props;
      }
      if (sc.addArchiveProvider) needsArchiveProvider = true;
    }
  }

  if (template.Outputs) {
    for (const [key, output] of Object.entries(template.Outputs)) {
      tfOutputs[key] = {
        value: resolveValue(output.Value, ctx),
        description: output.Export.Name,
      };
    }
  }

  const variables: Record<string, unknown> = {
    aws_region: { type: 'string', default: 'us-east-1' },
  };
  for (const [varName] of ctx.importVars) {
    variables[varName] = { type: 'string' };
  }

  // Merge ctx data sources + sidecar data sources
  const data: Record<string, unknown> = { ...tfData };
  if (ctx.usedDataSources.has('aws_region')) {
    data['aws_region'] = { current: {} };
  }
  if (ctx.usedDataSources.has('aws_caller_identity')) {
    data['aws_caller_identity'] = { current: {} };
  }

  const requiredProviders: Record<string, unknown> = {
    aws: { source: 'hashicorp/aws', version: '~> 5.0' },
  };
  if (needsArchiveProvider) {
    requiredProviders['archive'] = { source: 'hashicorp/archive', version: '~> 2.0' };
  }

  const result: Record<string, unknown> = {
    terraform: { required_providers: requiredProviders },
    provider: {
      aws: { region: '${var.aws_region}' },
    },
    variable: variables,
  };

  if (Object.keys(data).length > 0) result['data'] = data;
  if (Object.keys(tfResources).length > 0) result['resource'] = tfResources;
  if (Object.keys(tfOutputs).length > 0) result['output'] = tfOutputs;

  return result;
}
