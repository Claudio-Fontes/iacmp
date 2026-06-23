jest.mock('child_process');

import * as cp from 'child_process';
import { formatCommand, printPlan, runCommands } from '../../src/deploy/exec';
import { NativeCommand } from '../../src/deploy/types';

const mockedCp = cp as jest.Mocked<typeof cp>;

describe('formatCommand', () => {
  test('junta bin e args com espaço', () => {
    expect(formatCommand({ bin: 'aws', args: ['cloudformation', 'deploy'] })).toBe('aws cloudformation deploy');
  });

  test('coloca aspas em args com espaço', () => {
    expect(formatCommand({ bin: 'echo', args: ['ola mundo'] })).toBe('echo "ola mundo"');
  });
});

describe('printPlan', () => {
  test('imprime cada comando formatado, prefixado com "$"', () => {
    const logs: string[] = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((msg: string) => { logs.push(msg); });

    printPlan([{ bin: 'aws', args: ['s3', 'ls'] }, { bin: 'terraform', args: ['apply'] }]);

    expect(logs.some(l => l.includes('aws s3 ls'))).toBe(true);
    expect(logs.some(l => l.includes('terraform apply'))).toBe(true);
    spy.mockRestore();
  });
});

describe('runCommands', () => {
  beforeEach(() => jest.resetAllMocks());

  test('executa cada comando na ordem, com stdio inherit', () => {
    mockedCp.execFileSync.mockReturnValue('' as any);
    const commands: NativeCommand[] = [{ bin: 'terraform', args: ['init'] }, { bin: 'terraform', args: ['apply'] }];

    runCommands(commands);

    expect(mockedCp.execFileSync).toHaveBeenCalledTimes(2);
    expect(mockedCp.execFileSync).toHaveBeenNthCalledWith(1, 'terraform', ['init'], expect.objectContaining({ stdio: 'inherit' }));
    expect(mockedCp.execFileSync).toHaveBeenNthCalledWith(2, 'terraform', ['apply'], expect.objectContaining({ stdio: 'inherit' }));
  });

  test('lança erro claro quando um comando falha, e interrompe os seguintes', () => {
    mockedCp.execFileSync
      .mockImplementationOnce(() => { throw new Error('boom'); });
    const commands: NativeCommand[] = [{ bin: 'aws', args: ['cloudformation', 'deploy'] }, { bin: 'aws', args: ['nunca-chega'] }];

    expect(() => runCommands(commands)).toThrow('aws cloudformation deploy');
    expect(mockedCp.execFileSync).toHaveBeenCalledTimes(1);
  });
});
