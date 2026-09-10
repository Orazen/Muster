// Keep transport/controller tests native-free; screen tests use React Native's
// official host stubs and the renderer matching this app's React 18 runtime.
const transform = {
  "\\.[jt]sx?$": ["babel-jest", { presets: ["babel-preset-expo"] }],
};

module.exports = {
  projects: [
    {
      displayName: "core",
      rootDir: __dirname,
      testMatch: ["<rootDir>/src/**/*.test.ts"],
      testEnvironment: "node",
      transform,
    },
    {
      displayName: "screens",
      rootDir: __dirname,
      preset: "react-native",
      haste: { defaultPlatform: "android", platforms: ["android", "ios", "native"] },
      testMatch: ["<rootDir>/src/screens/**/*.test.tsx"],
      transform,
      transformIgnorePatterns: ["node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo-status-bar)/)"],
    },
  ],
};
