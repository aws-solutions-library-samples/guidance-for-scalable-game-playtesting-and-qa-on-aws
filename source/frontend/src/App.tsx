/*
 * (c) 2023 Amazon Web Services, Inc. or its affiliates. All Rights Reserved.
 * 
 * This AWS Content is provided subject to the terms of the AWS Customer Agreement available at http://aws.amazon.com/agreement or other written agreement between Customer and either Amazon Web Services, Inc. or Amazon Web Services EMEA SARL or both.
 */


import '@aws-amplify/ui-react/styles.css';

import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { fetchAuthSession } from "aws-amplify/auth";
import {Authenticator} from '@aws-amplify/ui-react';

import Application from "./components/Application";


export default function App() {

    const [allowed, setAllowed] = useState<boolean | null>(null);

    // You don't need to run this outside the Authenticator
    const checkGroup = async () => {
        const session = await fetchAuthSession();
        const idToken = session.tokens?.idToken?.toString();
        const payload = idToken ? JSON.parse(atob(idToken.split('.')[1])) : {};
        const groups: string[] = payload["cognito:groups"] || [];

        setAllowed(groups.includes("Admin"));
    };

    return (
        <Authenticator hideSignUp={true}>
            {({ signOut, user }) => {
                if (allowed === null) {
                    checkGroup();
                    return <div>Loading group permissions...</div>;
                }

                if (!allowed) {
                    return <Navigate to="/playtest" replace />;
                }

                return <Application signOut={signOut} />;
            }}
        </Authenticator>
    );
}