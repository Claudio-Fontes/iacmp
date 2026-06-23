module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/test/**/*.test.ts'],
  globalSetup: '<rootDir>/support/global-setup.js',
  testTimeout: 30 * 60 * 1000, // até 30min por teste — EKS/RDS são lentos de verdade
};
