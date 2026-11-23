import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import AppPT from './AppPT';
import "@cloudscape-design/global-styles/index.css"
// English labels for Cloudscape components that don't get explicit strings (for example the
// split panel's preferences buttons on the playtester page; issue #41).
import { I18nProvider } from '@cloudscape-design/components/i18n';
import enMessages from '@cloudscape-design/components/i18n/messages/all.en';

//Matt Added Below
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Amplify } from 'aws-amplify';

// Amplify config is sourced from aws-config.generated.json (regenerated each deploy).
// index.tsx is never mutated by the deploy process, keeping destroy/redeploy idempotent.
import awsConfig from './aws-config';

Amplify.configure(awsConfig)

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);
root.render(
  <React.StrictMode>
    <I18nProvider locale="en" messages={[enMessages]}>
        <BrowserRouter>
            <Routes>
                <Route path="*" element={<App />} />
                <Route path="/playtest/*" element={<AppPT />} />
            </Routes>
        </BrowserRouter>
    </I18nProvider>
  </React.StrictMode>
);