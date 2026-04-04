/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        pixel: ['"Fusion Pixel 12px Monospaced SC"', 'ui-monospace', 'monospace'],
        sans: ['"PingFang SC"', '"Hiragino Sans GB"', '"Microsoft YaHei"', 'sans-serif'],
      },
      colors: {
        primary: {
          50: '#e6feff',
          100: '#ccfbff',
          200: '#9fffff',
          300: '#78fbff',
          400: '#5df2ff',
          500: '#37d6eb',
          600: '#1ca6b9',
          700: '#147a8b',
          800: '#0e5a67',
          900: '#0a404b',
        },
        pixel: {
          bg: '#08111f',
          panel: '#16213a',
          panelSoft: '#1a2c4d',
          line: '#2a466b',
          text: '#e6f7ff',
          muted: '#89a7c3',
          neon: '#5df2ff',
          pink: '#ff66d4',
          lime: '#c7ff6b',
          amber: '#ffbf5a',
          danger: '#ff6b6b',
        },
      },
    },
  },
  plugins: [],
};
