import { Stack, BaseConstruct } from '@iacmp/core';

const INSTANCE_TYPE_MAP: Record<string, string> = {
  small: 't3.small',
  medium: 't3.medium',
  large: 't3.large',
};

function indent(text: string, spaces = 2): string {
  return text.split('\n').map(l => (l.trim() ? ' '.repeat(spaces) + l : l)).join('\n');
}

function block(type: string, labels: string[], body: string): string {
  const labelStr = labels.map(l => ` "${l}"`).join('');
  return `${type}${labelStr} {\n${body}\n}\n`;
}

function attr(key: string, value: string | number | boolean): string {
  if (typeof value === 'string') return `${key} = "${value}"`;
  return `${key} = ${value}`;
}

function tagsBlock(name: string): string {
  return indent(`tags = {\n${indent(`Name = "${name}"`)}\n}`);
}

function synthesizeConstruct(construct: BaseConstruct): string {
  const props = construct.props as Record<string, unknown>;
  const id = construct.id.replace(/[^a-zA-Z0-9_]/g, '_');

  switch (construct.type) {
    case 'Compute.Instance': {
      const instanceType = INSTANCE_TYPE_MAP[props.instanceType as string] ?? 't3.small';
      const body = indent([
        attr('ami', (props.image as string) ?? 'ami-ubuntu-22.04'),
        attr('instance_type', instanceType),
        '',
        tagsBlock(construct.id),
      ].join('\n'));
      return block('resource', ['aws_instance', id], body);
    }

    case 'Storage.Bucket': {
      const versioning = (props.versioning as boolean) ?? false;
      const blockPublic = !(props.publicAccess as boolean);
      const bucketName = construct.id.toLowerCase();

      // BUG-08 fix: emite bucket + versioning + public_access_block separados
      const bucketBody = indent([
        attr('bucket', bucketName),
        '',
        tagsBlock(construct.id),
      ].join('\n'));

      const versioningBody = indent([
        `bucket = aws_s3_bucket.${id}.id`,
        `versioning_configuration {`,
        `  status = "${versioning ? 'Enabled' : 'Suspended'}"`,
        `}`,
      ].join('\n'));

      const pabBody = indent([
        `bucket                  = aws_s3_bucket.${id}.id`,
        attr('block_public_acls', blockPublic),
        attr('block_public_policy', blockPublic),
        attr('ignore_public_acls', blockPublic),
        attr('restrict_public_buckets', blockPublic),
      ].join('\n'));

      return [
        block('resource', ['aws_s3_bucket', id], bucketBody),
        block('resource', ['aws_s3_bucket_versioning', `${id}_versioning`], versioningBody),
        block('resource', ['aws_s3_bucket_public_access_block', `${id}_pab`], pabBody),
      ].join('\n');
    }

    case 'Network.VPC': {
      const body = indent([
        attr('cidr_block', (props.cidr as string) ?? '10.0.0.0/16'),
        attr('enable_dns_hostnames', true),
        attr('enable_dns_support', true),
        '',
        tagsBlock(construct.id),
      ].join('\n'));
      return block('resource', ['aws_vpc', id], body);
    }

    case 'Database.SQL': {
      const engine = (props.engine as string) ?? 'mysql';
      const body = indent([
        attr('identifier', construct.id.toLowerCase()),
        attr('engine', engine),
        attr('engine_version', engine === 'postgres' ? '15.4' : '8.0.36'),
        attr('instance_class', (props.instanceType as string) ?? 'db.t3.micro'),
        attr('allocated_storage', 20),
        attr('username', 'dbadmin'),
        attr('password', 'changeme'),
        attr('multi_az', (props.multiAz as boolean) ?? false),
        attr('skip_final_snapshot', false),
        attr('storage_encrypted', true),
        attr('backup_retention_period', 7),
        '',
        tagsBlock(construct.id),
      ].join('\n'));
      return block('resource', ['aws_db_instance', id], body);
    }

    case 'Function.Lambda': {
      const environment = props.environment as Record<string, string> | undefined;

      // BUG-01 fix: emite bloco environment quando definido
      const envBlock = environment && Object.keys(environment).length > 0
        ? '\n' + indent([
            'environment {',
            indent('variables = {', 2),
            ...Object.entries(environment).map(([k, v]) => indent(indent(attr(k, v), 2), 2)),
            indent('}', 2),
            '}',
          ].join('\n'))
        : '';

      const body = indent([
        attr('function_name', construct.id),
        attr('runtime', 'nodejs20.x'),
        attr('handler', (props.handler as string) ?? 'index.handler'),
        attr('role', 'arn:aws:iam::ACCOUNT_ID:role/lambda-role'),
        '',
        `filename = "function.zip"`,
        `source_code_hash = filebase64sha256("function.zip")`,
        '',
        (props.memory ? attr('memory_size', props.memory as number) : ''),
        (props.timeout ? attr('timeout', props.timeout as number) : ''),
        envBlock,
        '',
        tagsBlock(construct.id),
      ].filter(l => l !== '').join('\n'));
      return block('resource', ['aws_lambda_function', id], body);
    }

    default:
      return '';
  }
}

export function synthesize(stack: Stack): string {
  const awsBlock = block('aws', [], indent(`source  = "hashicorp/aws"\nversion = "~> 5.0"`));
  const requiredProvidersBlock = block('required_providers', [], indent(awsBlock));
  const terraformBlock = block('terraform', [], indent(requiredProvidersBlock));
  const providerBlock = block('provider', ['aws'], indent(attr('region', 'us-east-1')));

  const header = [terraformBlock, providerBlock].join('\n');

  const resources = stack.constructs
    .map(c => synthesizeConstruct(c))
    .filter(Boolean)
    .join('\n');

  return [header, resources].filter(Boolean).join('\n');
}
