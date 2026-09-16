import { theme, type ThemeConfig } from 'antd'

// 统一字体栈：西文 Inter，中文 PingFang / 微软雅黑，数字等宽清晰
const FONT =
  "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif"

const FONT_NUM = "'Inter', 'SF Mono', 'Roboto Mono', 'PingFang SC', sans-serif"

// 浅色：清爽科技蓝，白色玻璃卡片
export const lightTheme: ThemeConfig = {
  algorithm: theme.defaultAlgorithm,
  token: {
    colorPrimary: '#2563eb',
    colorInfo: '#2563eb',
    colorSuccess: '#16a34a',
    colorWarning: '#d97706',
    colorError: '#dc2626',
    colorBgBase: '#eef2f9',
    colorBorder: '#e3e8f0',
    colorBorderSecondary: '#eef1f6',
    borderRadius: 10,
    fontSize: 14,
    fontFamily: FONT,
    fontFamilyCode: FONT_NUM,
    colorTextBase: '#1f2937',
    colorTextHeading: '#0f172a',
    wireframe: false,
  },
  components: {
    Layout: {
      headerBg: 'rgba(255,255,255,0.72)',
      bodyBg: 'transparent',
      siderBg: 'rgba(255,255,255,0.72)',
    },
    Menu: {
      itemBg: 'transparent',
      itemSelectedBg: 'rgba(37,99,235,0.10)',
      itemSelectedColor: '#2563eb',
      itemHoverBg: 'rgba(37,99,235,0.06)',
      itemHeight: 46,
      iconSize: 16,
    },
    Card: {
      colorBgContainer: '#ffffff',
      headerBg: 'transparent',
    },
    Table: {
      headerBg: '#f3f6fb',
      headerColor: '#475569',
      rowHoverBg: 'rgba(37,99,235,0.06)',
      borderColor: '#eef1f6',
      colorBgContainer: '#ffffff',
    },
    Modal: {
      contentBg: '#ffffff',
      headerBg: 'transparent',
    },
    Drawer: {
      colorBgElevated: '#ffffff',
    },
    Descriptions: {
      labelBg: '#f7f9fc',
      titleColor: '#334155',
    },
    Button: {
      primaryShadow: '0 0 0 0',
    },
    Statistic: {
      contentFontSize: 30,
    },
  },
}

// 深色：深空蓝黑，霓虹青紫点缀，玻璃拟态
export const darkTheme: ThemeConfig = {
  algorithm: theme.darkAlgorithm,
  token: {
    colorPrimary: '#38bdf8',
    colorInfo: '#38bdf8',
    colorSuccess: '#34d399',
    colorWarning: '#fbbf24',
    colorError: '#f87171',
    colorBgBase: '#0b1120',
    colorBorder: 'rgba(148,163,184,0.16)',
    colorBorderSecondary: 'rgba(148,163,184,0.10)',
    borderRadius: 10,
    fontSize: 14,
    fontFamily: FONT,
    fontFamilyCode: FONT_NUM,
    colorTextBase: '#e2e8f0',
    colorTextHeading: '#f1f5f9',
  },
  components: {
    Layout: {
      headerBg: 'rgba(15,23,42,0.66)',
      bodyBg: 'transparent',
      siderBg: 'rgba(15,23,42,0.66)',
    },
    Menu: {
      itemBg: 'transparent',
      itemSelectedBg: 'rgba(56,189,248,0.16)',
      itemSelectedColor: '#7dd3fc',
      itemHoverBg: 'rgba(56,189,248,0.10)',
      itemHeight: 46,
      iconSize: 16,
    },
    Card: {
      colorBgContainer: 'rgba(17,24,39,0.66)',
      headerBg: 'transparent',
    },
    Table: {
      headerBg: 'rgba(30,41,59,0.8)',
      headerColor: '#cbd5e1',
      rowHoverBg: 'rgba(56,189,248,0.10)',
      borderColor: 'rgba(148,163,184,0.12)',
      colorBgContainer: 'rgba(17,24,39,0.5)',
    },
    Modal: {
      contentBg: 'rgba(15,23,42,0.96)',
      headerBg: 'transparent',
    },
    Drawer: {
      colorBgElevated: 'rgba(15,23,42,0.96)',
    },
    Descriptions: {
      labelBg: 'rgba(30,41,59,0.7)',
      titleColor: '#e2e8f0',
    },
    Button: {
      primaryShadow: '0 0 0 0',
    },
    Statistic: {
      contentFontSize: 30,
    },
  },
}
