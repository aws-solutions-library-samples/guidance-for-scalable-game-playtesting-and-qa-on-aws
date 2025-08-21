import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import AppPT from './AppPT';
import "@cloudscape-design/global-styles/index.css"

//Matt Added Below
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Amplify } from 'aws-amplify';


Amplify.configure({
    Auth: {
        Cognito: {
            userPoolId: "us-east-2_x31kPEcMU",
            userPoolClientId: "2dbf564efr2i2ui5s9bfhe2qt9"
        }
    },
    API: {
        REST: {
            "playtesting-api": {
                endpoint: "https://p02bqbfzk9.execute-api.us-east-2.amazonaws.com/prod",

            }
        }
    }
})

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);
root.render(
  <React.StrictMode>
        <BrowserRouter>
            <Routes>
                <Route path="*" element={<App />} />
                <Route path="/playtest/*" element={<AppPT />} />
            </Routes>
        </BrowserRouter>
  </React.StrictMode>
);