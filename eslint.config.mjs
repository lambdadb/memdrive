import globals from 'globals';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
    { ignores: ['dist/**', 'artifacts/**', 'node_modules/**'] },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ['src/**/*.ts'],
        languageOptions: { globals: globals.browser },
        rules: {
            // The compiler owns unused declarations, including type-only names.
            '@typescript-eslint/no-unused-vars': 'off',
        },
    },
];
