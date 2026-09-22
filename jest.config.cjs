module.exports = {
  preset: "ts-jest/presets/default-esm",
  extensionsToTreatAsEsm: [".ts"],
  testEnvironment: "node",
  testMatch: ["<rootDir>/test/**/*.test.ts"],
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        useESM: true,
        tsconfig: { module: "ESNext", rootDir: "." }
      }
    ]
  },
  moduleNameMapper: { "^(\\.{1,2}/.*)\\.js$": "$1" }
};
