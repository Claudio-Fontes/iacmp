import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { auditArtifacts } from '../src/audit/artifact';

/**
 * Fixtures INSEGURAS por regra (auditoria P2-01): cada check precisa provar que
 * pega o caso ruim — um auditor que só diz "OK" é pior que nenhum.
 */
function projectWith(files: Record<string, unknown | string>, provider = 'aws'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-audit-'));
  const out = path.join(dir, 'synth-out', provider);
  fs.mkdirSync(out, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(out, name), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

describe('auditArtifacts — CloudFormation', () => {
  it('pega iam:PassRole com Resource *', () => {
    const dir = projectWith({
      'x.json': {
        Resources: {
          BadRole: {
            Type: 'AWS::IAM::Role',
            Properties: {
              Policies: [{ PolicyDocument: { Statement: [{ Effect: 'Allow', Action: ['iam:PassRole'], Resource: '*' }] } }],
            },
          },
        },
      },
    });
    const r = auditArtifacts(dir, 'aws');
    expect(r.findings.some(f => f.check === 'iam-passrole-wildcard' && f.level === 'critical')).toBe(true);
  });

  it('pega policy com Resource * (warning)', () => {
    const dir = projectWith({
      'x.json': {
        Resources: {
          Role: {
            Type: 'AWS::IAM::Role',
            Properties: {
              Policies: [{ PolicyDocument: { Statement: [{ Effect: 'Allow', Action: ['s3:GetObject'], Resource: '*' }] } }],
            },
          },
        },
      },
    });
    expect(auditArtifacts(dir, 'aws').findings.some(f => f.check === 'iam-wildcard')).toBe(true);
  });

  it('pega SSH aberto para o mundo', () => {
    const dir = projectWith({
      'x.json': {
        Resources: {
          SG: {
            Type: 'AWS::EC2::SecurityGroup',
            Properties: { SecurityGroupIngress: [{ IpProtocol: 'tcp', FromPort: 22, ToPort: 22, CidrIp: '0.0.0.0/0' }] },
          },
        },
      },
    });
    expect(auditArtifacts(dir, 'aws').findings.some(f => f.check === 'open-ingress' && f.level === 'critical')).toBe(true);
  });

  it('NÃO acusa porta 443 aberta (HTTPS público é normal)', () => {
    const dir = projectWith({
      'x.json': {
        Resources: {
          SG: {
            Type: 'AWS::EC2::SecurityGroup',
            Properties: { SecurityGroupIngress: [{ IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '0.0.0.0/0' }] },
          },
        },
      },
    });
    expect(auditArtifacts(dir, 'aws').findings.some(f => f.check === 'open-ingress')).toBe(false);
  });

  it('pega rota de API sem autorização', () => {
    const dir = projectWith({
      'x.json': { Resources: { R: { Type: 'AWS::ApiGatewayV2::Route', Properties: { AuthorizationType: 'NONE' } } } },
    });
    expect(auditArtifacts(dir, 'aws').findings.some(f => f.check === 'api-unauthenticated')).toBe(true);
  });

  it('NÃO acusa rota com JWT', () => {
    const dir = projectWith({
      'x.json': { Resources: { R: { Type: 'AWS::ApiGatewayV2::Route', Properties: { AuthorizationType: 'JWT' } } } },
    });
    expect(auditArtifacts(dir, 'aws').findings.some(f => f.check === 'api-unauthenticated')).toBe(false);
  });

  it('pega bucket sem PublicAccessBlock', () => {
    const dir = projectWith({ 'x.json': { Resources: { B: { Type: 'AWS::S3::Bucket', Properties: {} } } } });
    expect(auditArtifacts(dir, 'aws').findings.some(f => f.check === 'public-storage')).toBe(true);
  });

  it('pega segredo literal em Output, mas ignora dynamic reference', () => {
    const dirBad = projectWith({ 'x.json': { Resources: {}, Outputs: { DbPassword: { Value: 'hunter2' } } } });
    expect(auditArtifacts(dirBad, 'aws').findings.some(f => f.check === 'secret-in-output')).toBe(true);

    const dirOk = projectWith({
      'x.json': { Resources: {}, Outputs: { DbPassword: { Value: '{{resolve:secretsmanager:x:SecretString:password}}' } } },
    });
    expect(auditArtifacts(dirOk, 'aws').findings.some(f => f.check === 'secret-in-output')).toBe(false);
  });
});

describe('auditArtifacts — Terraform (GCP)', () => {
  it('pega role primitiva no projeto e allUsers invoker', () => {
    const dir = projectWith({
      'x.tf.json': {
        resource: {
          google_project_iam_member: { m: { role: 'roles/editor' } },
          google_cloud_run_v2_service_iam_member: { pub: { member: 'allUsers' } },
        },
      },
    }, 'gcp');
    const r = auditArtifacts(dir, 'gcp');
    expect(r.findings.some(f => f.check === 'iam-wildcard' && f.level === 'critical')).toBe(true);
    expect(r.findings.some(f => f.check === 'public-invoker')).toBe(true);
  });

  it('pega firewall aberto em porta de banco', () => {
    const dir = projectWith({
      'x.tf.json': {
        resource: {
          google_compute_firewall: { fw: { source_ranges: ['0.0.0.0/0'], allow: [{ protocol: 'tcp', ports: ['5432'] }] } },
        },
      },
    }, 'gcp');
    expect(auditArtifacts(dir, 'gcp').findings.some(f => f.check === 'open-ingress')).toBe(true);
  });
});

describe('auditArtifacts — Bicep e honestidade dos estados', () => {
  it('pega storage sem HTTPS obrigatório', () => {
    const dir = projectWith({
      'x.bicep': "resource sa 'Microsoft.Storage/storageAccounts@2023-01-01' = { properties: { minimumTlsVersion: 'TLS1_2' } }",
    }, 'azure');
    expect(auditArtifacts(dir, 'azure').findings.some(f => f.check === 'tls-enforced')).toBe(true);
  });

  it('sem artefatos: não analisa nada e NÃO reporta aprovação', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iacmp-audit-empty-'));
    const r = auditArtifacts(dir, 'aws');
    expect(r.filesAnalyzed).toHaveLength(0);
    expect(r.findings).toHaveLength(0);
    expect(r.checked).toHaveLength(0); // nada checado ⇒ nenhum PASS
  });

  it('check sem alvo vira NOT_APPLICABLE (nunca PASS silencioso)', () => {
    const dir = projectWith({ 'x.json': { Resources: { T: { Type: 'AWS::DynamoDB::Table', Properties: {} } } } });
    const r = auditArtifacts(dir, 'aws');
    expect(r.checked.find(c => c.check === 'open-ingress')?.status).toBe('NOT_APPLICABLE');
    expect(r.checked.find(c => c.check === 'public-storage')?.status).toBe('NOT_APPLICABLE');
  });

  it('artefato ilegível vira NOT_CHECKED, não PASS', () => {
    const dir = projectWith({ 'x.json': '{ isso não é json' });
    const r = auditArtifacts(dir, 'aws');
    expect(r.findings.some(f => f.status === 'NOT_CHECKED')).toBe(true);
  });
});
