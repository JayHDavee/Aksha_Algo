import { createTheme } from "@mui/material";

const theme = createTheme({
    palette: {
      primary: {
        main: '#035faa',
        dark: '#024578',
        light: '#e3edf7',
        contrastText: '#ffffff',
      },
      success: {
        main: '#27ae60',
      },
      error: {
        main: '#dc3545',
      },
      background: {
        default: '#f5f7fb',
        paper: '#ffffff',
      },
      text: {
        primary: '#111827',
        secondary: '#6c7689',
      },
    },
    shape: {
      borderRadius: 12,
    },
    typography: {
      fontFamily: 'Inter, sans-serif',
      button: {
        textTransform: "none",

      },

    },

    components: {
      MuiCssBaseline: {
        styleOverrides: `
          @font-face {
            font-family:'Inter, sans-serif';
            font-style: normal;
            font-display: swap;
            font-weight: 300;
          }
          textTransform:none
        `,
      },
      MuiButton: {
        styleOverrides: {
          root: {
            borderRadius: 8,
            boxShadow: 'none',
          },
          contained: {
            boxShadow: 'none',
            '&:hover': {
              boxShadow: 'none',
            },
          },
        },
      },
      MuiPaper: {
        styleOverrides: {
          rounded: {
            borderRadius: 12,
          },
        },
      },
      MuiDialog: {
        styleOverrides: {
          paper: {
            borderRadius: 16,
          },
        },
      },
      MuiChip: {
        styleOverrides: {
          root: {
            borderRadius: 999,
          },
        },
      },
    },
  });

  export default theme