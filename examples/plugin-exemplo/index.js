const { definePlugin } = require('@iacmp/plugin-sdk');

module.exports = definePlugin({
  providers: [{
    name: 'digitalocean',
    synthesize(stack) {
      return {
        provider: 'digitalocean',
        stack: stack.name,
        resources: stack.constructs.map(c => ({
          type: c.type,
          id: c.id,
          props: c.props,
        })),
      };
    },
  }],
});
