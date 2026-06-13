export interface BaseConstruct {
  readonly id: string;
  readonly type: string;
  readonly props: Record<string, unknown>;
}

export class Stack {
  readonly name: string;
  readonly constructs: BaseConstruct[] = [];
  provider?: string;
  region?: string;

  constructor(name: string, props?: { provider?: string; region?: string }) {
    this.name = name;
    this.provider = props?.provider;
    this.region = props?.region;
  }

  addConstruct(construct: BaseConstruct): void {
    this.constructs.push(construct);
  }
}
