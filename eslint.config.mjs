import typescriptEslint from "typescript-eslint";

const sharedRules = {
  curly: ["error", "all"],
  eqeqeq: ["error", "always"],
  "no-constant-condition": "error",
  "no-debugger": "error",
  "no-throw-literal": "error",
};

export default [
  {
    ignores: [
      "_bmad/**",
      "_bmad-output/**",
      ".agents/**",
      ".github/agents/**",
      ".history/**",
      "design-artifacts/**",
      "node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/out/**",
      "coverage/**",
      "tests/fixtures/**",
    ],
  },
  {
    files: ["scripts/**/*.{js,mjs,cjs}", "*.{js,mjs,cjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      globals: {
        Buffer: "readonly",
        URL: "readonly",
        console: "readonly",
        process: "readonly",
        setTimeout: "readonly",
      },
      sourceType: "module",
    },
    rules: {
      ...sharedRules,
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["apps/**/*.ts", "packages/**/*.ts", "tests/**/*.ts", "*.ts"],
    languageOptions: {
      ecmaVersion: "latest",
      parser: typescriptEslint.parser,
      sourceType: "module",
    },
    plugins: {
      "@typescript-eslint": typescriptEslint.plugin,
    },
    rules: {
      ...sharedRules,
      "no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
];
