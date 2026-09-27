const { defineConfig } = require("eslint/config");
const expoConfig = require("eslint-config-expo/flat");
module.exports = defineConfig([
  expoConfig,
  { ignores: ["dist/**", ".expo/**"] },
  // Loading data when a screen mounts is a supported effect pattern.
  { rules: { "react-hooks/set-state-in-effect": "off" } },
]);
