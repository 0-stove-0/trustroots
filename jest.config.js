module.exports = {
  moduleNameMapper: {
    '@/(.*)$': '<rootDir>/$1',
  },
  testMatch: [
    '<rootDir>/modules/*/tests/client/components/*.tests.js',
  ],
};

