import React from 'react';
import Tabs from '../../component/Tabs/ColorTabs';
import Active from '../../component/monitor/Active';
import Spotlight from '../../component/monitor/Spotlight';

/**
 * Monitor Component
 * Displays a tab layout for "Live" and "Spotlight" views using a shared <Tabs> component.
 */
const Monitor: React.FC = () => {
  return (
    <div style={{ marginTop: 68 }}>
      <Tabs
        tabName={[
          { value: 'one', label: 'Live' },
          { value: 'two', label: 'Spotlight' },
        ]}
        pages={[
          { value: 'one', component: <Active /> },
          { value: 'two', component: <Spotlight /> },
        ]}
      />
    </div>
  );
};

export default Monitor;