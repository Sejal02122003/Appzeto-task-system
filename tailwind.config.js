/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      boxShadow: {
        glow: '0 18px 40px rgba(56, 189, 248, 0.18)',
      },
    },
  },
  plugins: [],
};

