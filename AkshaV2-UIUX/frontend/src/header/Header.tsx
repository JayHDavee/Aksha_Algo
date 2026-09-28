import React, { useEffect, useState } from "react";
import { useDispatch } from "react-redux";
import { useLocation, useNavigate } from "react-router-dom";
import { IconButton, Box, AppBar, Button, FormControl, InputLabel, Select, MenuItem, OutlinedInput } from "@mui/material";
import MenuIcon from "@mui/icons-material/Menu";
import _ from "lodash";
import dayjs from "dayjs";
import { useTranslation } from "react-i18next";


// Redux actions
import { fetchUser, getAllSpotLight } from "../global_store/reducers/monitorReducer";
import { fetchAlertReport, setAlertDate } from "../global_store/reducers/alertReportReducer";

// Services
import { getDailyAlertReport } from "../services/alertReportService";


// Components
import { pages } from "./headerData";
import UserManual from "./subComponents/UserManual";
import UserProfileDropDown from "./UserProfileDropDown";
import MobileMenu from "./subComponents/MobileMenu";
import DesktopMenu from "./subComponents/DesktopMenu";
import Settingss from "./subComponents/Settingss";
import CustomDropdown from "../component/common/CustomDropdown";
import { useFeatureFlags } from "../context/FeatureFlagsContext";
// Assetsent/common/CustomDropDown";

import logo from "../assets/images/AkshaLogo.png";
import cpcLogo from "../../public/assets/img/CPC logo.svg"
import helpIcon from "../assets/images/icons/help.png";



// Styles
import "./styles/header.scss";


const Header: React.FC = () => {
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const location = useLocation();

  const allRoutePathNames = pages.map(item => item.pageUrl);
  const featureFlags = useFeatureFlags();

  const visiblePages = (flags: typeof featureFlags) =>
    pages.filter((page) => !page.featureFlag || (flags as any)[page.featureFlag]);

  const [notificationCount, setNotificationCount] = useState(0);
  const [showNotification, setShowNotification] = useState(false);
  const [selectedModule, setSelectedModule] = useState('');
  const [navigation, setNavigation] = useState(visiblePages(featureFlags));

  // Feature-flagged nav items (e.g. Jewelry Dashboard) start hidden — flags
  // load asynchronously after mount — and appear once the flag resolves true.
  useEffect(() => {
    setNavigation(visiblePages(featureFlags));
  }, [featureFlags]);
  const [modalOpen, setModalOpen] = useState(false);
  const [anchorElNav, setAnchorElNav] = useState<null | HTMLElement>(null);

  const { t, i18n } = useTranslation();


  // Menu items for user manual
  const menu = [
    {
      key: '1',
      label: (
        <a href="#!" onClick={(e) => { e.preventDefault(); setModalOpen(true); }}>
          {t("userManual")}
        </a>
      ),
    },
  ];

  useEffect(() => {
    if (selectedModule === 'Monitor') {
      localStorage.setItem("notifications_count", JSON.stringify(null));
      setNotificationCount(0);
    }
  }, [selectedModule]);

  useEffect(() => {
    if (location.pathname === '/monitor') {
      setShowNotification(false);
    }

    handleRouteChange();
  }, [location]);

  const handleOpenNavMenu = (event: React.MouseEvent<HTMLElement>) => {
    setAnchorElNav(event.currentTarget);
  };

  const handleCloseNavMenu = () => {
    setAnchorElNav(null);
  };

  const handleModalClose = () => {
    setModalOpen(false);
  };

  const handleSettingsClick = () => {
    const resetNavigation = navigation.map(page => ({ ...page, active: false }));
    setNavigation(resetNavigation);

    localStorage.setItem('tabValue', JSON.stringify("one"));
    navigate("/cameraDirectory");
  };

  const handleMenuChange = (page: any, index: number, mobileMenu = false) => {
    if (mobileMenu) handleCloseNavMenu();

    if (page.pageUrl === "/insights") {
      handleFetchAlertReport();
    }

    localStorage.setItem('tabValue', JSON.stringify("one"));
    navigate(page.pageUrl);
  };

  const handleFetchAlertReport = async () => {
    const formattedDate = dayjs().subtract(1, 'day').format('YYYY-MM-DD');

    try {
      const { data: allData } = await getDailyAlertReport(formattedDate);
      dispatch(fetchAlertReport(allData));
    } catch {
      dispatch(fetchAlertReport({}));
    } finally {
      dispatch(setAlertDate(formattedDate));
    }
  };

  const handleLogoClick = () => {
    localStorage.setItem('tabValue', JSON.stringify("one"));
    navigate("/monitor");
  };

  const handleRouteChange = () => {
    const currentLocation = location.pathname === '/' ? '/monitor' : location.pathname;

    // Match by URL, not by a shared index with allRoutePathNames — navigation
    // is a feature-flag-filtered subset of pages, so the two arrays can have
    // different lengths/indices once a flagged route (e.g. Jewelry Dashboard)
    // is hidden. A shared-index lookup would silently pull from the wrong
    // slot, or throw if navigation is shorter than the index from pages.
    if (currentLocation && allRoutePathNames.includes(currentLocation)) {
      const updatedNav = navigation.map((page) => ({
        ...page,
        active: page.pageUrl === currentLocation,
      }));

      setNavigation(updatedNav);
      const matched = updatedNav.find((page) => page.pageUrl === currentLocation);
      if (matched) {
        setSelectedModule(matched.name);
      }
    }
  };

  const handleChange = (event: any) => {
    const newLang = event.target.value;
    i18n.changeLanguage(newLang);  // switch language in i18next
  };
  const SHOW_LANGUAGE = import.meta.env.VITE_SHOW_LANGUAGE === "true";
  return (
    <>
      <AppBar
        position="static"
        sx={{
          background: "linear-gradient(135deg, #035faa 0%, #024578 100%)",
          boxShadow: "var(--shadow-md)",
          position: "fixed",
          zIndex: 999,
          top: 0,
          height: "68px",
        }}
        className="headerCls"
      >
        <IconButton
          size="small"
          aria-label="menu"
          aria-controls="menu-appbar"
          aria-haspopup="true"
          onClick={handleOpenNavMenu}
          color="inherit"
          sx={{ flexGrow: 1, display: { xs: "flex", md: "none" } }}
        >
          <MenuIcon style={{ color: "white" }} />
          {showNotification && (
            <div className="green-teek d-block d-sm-block d-md-block d-lg-none d-xl-none"></div>
          )}
        </IconButton>

        {/* <img
          src={cpcLogo}
          alt="aksha logo"
          className="aksha-logo-img"
        /> */}
        <span className="logo-chip" onClick={handleLogoClick}>
          <img
            src={logo}
            alt="aksha logo"
            className="aksha-logo-img"
          />
        </span>

        {showNotification && (
          <div className="green-teek d-none d-sm-none d-md-none d-lg-block d-xl-block"></div>
        )}

        {/* Small screen menu */}
        <Box sx={{ flexGrow: 1, display: { xs: "flex", md: "none" } }}>
          <MobileMenu
            anchorElNav={anchorElNav}
            onCloseNavMenu={handleCloseNavMenu}
            navigation={navigation}
            onItemSelect={handleMenuChange}
          />
        </Box>

        {/* Large screen menu */}
        <Box
          sx={{
            flexGrow: 1,
            display: { xs: "none", md: "flex" },
            justifyContent: "center",
          }}
        >
          <DesktopMenu
            navigation={navigation}
            onMenuChange={handleMenuChange}
          />
        </Box>

        {SHOW_LANGUAGE && (
          <Box sx={{ width: 150, margin: "5px", background: "white", borderRadius: "10px" }}>
            <FormControl fullWidth variant="outlined">
              <InputLabel id="language-label" sx={{
                marginTop: "7px", //smaller label text
              }}>Language</InputLabel>
              <Select
                labelId="language-label"
                id="language-select"
                value={i18n.language} // current language
                onChange={handleChange}
                sx={{
                  marginTop: "5px",     //  small space from top
                  height: "48px",
                  borderRadius: "10px",

                }}
                input={<OutlinedInput label="Language" />}  // binds the floating label
              //  this fixes the "label outside border" issue
              >
                <MenuItem value="en">English</MenuItem>
                <MenuItem value="ja">日本語</MenuItem>
              </Select>
            </FormControl>
          </Box>
        )}

        <Box sx={{ flexGrow: 0, display: "flex", alignItems: "center" }}>
          <Settingss onSettingsClick={handleSettingsClick} />
          <CustomDropdown items={menu}>
            <img
              src={helpIcon}
              alt="help"
              className="mx-2 user-manual-img user-manual-section"
            />
          </CustomDropdown>
        </Box>

        <UserProfileDropDown />
      </AppBar>

      <UserManual value={modalOpen} onModalClose={handleModalClose} />


    </>
  );
};

export default Header;