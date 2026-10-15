/**
 * ESLint の設定（flat 形式）。TypeScript のファイル（.ts）に、命名と書き方の規則を当てる。npm run lint（eslint src）が読む。
 * import は camelCase か PascalCase。curly・eqeqeq・no-throw-literal・semi は警告にする。
 */
import typescriptEslint from 'typescript-eslint';

export default [{
	files: ['**/*.ts'],
}, {
	plugins: {
		'@typescript-eslint': typescriptEslint.plugin,
	},

	languageOptions: {
		parser: typescriptEslint.parser,
		ecmaVersion: 2022,
		sourceType: 'module',
	},

	rules: {
		'@typescript-eslint/naming-convention': ['warn', {
			selector: 'import',
			format: ['camelCase', 'PascalCase'],
		}],

		curly: 'warn',
		eqeqeq: 'warn',
		'no-throw-literal': 'warn',
		semi: 'warn',
	},
}];
