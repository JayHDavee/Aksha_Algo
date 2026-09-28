// The code defines a functional component called Monitor, which is responsible for rendering two tabs named "Live" and "Spotlight". 
// The Tabs component is imported from "../../component/Tabs" and accepts two props, tabName and pages.

// The tabName prop is an array that contains two objects. Each object has two properties: value and label. 
// The value property is a unique identifier for each tab, and the label property is the text displayed on each tab.

// The pages prop is an array that contains two objects. Each object has two properties: value and component. 
// The value property is a reference to the value property of each object in the tabName prop. 
// The component property is a JSX element that corresponds to the content to be displayed on each tab.

// import the necessary components
import Tabs from "../../component/Tabs";
import Active from "../../component/monitor/Active";
import Spotlight from "../../component/monitor/Spotlight";
import { useSelector } from 'react-redux';

// define a component called 'Monitor'
const Monitor = () => {
  const { token, email, role } = useSelector((state) => state.auth || {});
  console.log(token, email, role);

  return (
    // wrap the 'Tabs' component inside a div with a margin-top of 58px
    <div style={{ marginTop: 58 }}>
      <Tabs
        // specify the tabs' names and labels
        tabName={[
          {
            value: "one",
            label: "Live",
          },
          {
            value: "two",
            label: "Spotlight",
          },
        ]}
        // specify the components to render when each tab is selected
        pages={[
          {
            value: "one",
            component: <Active />,
          },
          {
            value: "two",
            component: <Spotlight />,
          },
        ]}
      />
    </div>
  );
};

export default Monitor;
