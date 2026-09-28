import React from "react";
import "./styles/footer.scss";
import AlgoLogo from "../../public/assets/img/algo-logo.png"
import CPCLogo from "../../public/assets/img/CPClogo.jpg";

const Footer: React.FC = () => {
  return (
    <footer className="app-footer">
      <p>
        <img src={AlgoLogo} alt="AlgoLogo" />
        Product of Algoanalytics
      </p>
      <p>
        <img src={CPCLogo} alt="CPCLogo" />
        Machine Learning by CPC
      </p>
    </footer>
  );
};

export default Footer;
