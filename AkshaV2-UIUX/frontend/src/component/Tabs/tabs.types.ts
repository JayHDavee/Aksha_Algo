export type TabProps = {
  tabName: {
    value: string;
    label: string;
  }[];
  pages: {
    value: string;
    component: any;
  }[];
  // hideHeader?: boolean;   // ✅ ADD THIS
   showOnlyActiveTab?: boolean; 
};
