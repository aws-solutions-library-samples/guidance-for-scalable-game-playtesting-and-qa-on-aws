/*
 * (c) 2023 Amazon Web Services, Inc. or its affiliates. All Rights Reserved.
 * 
 * This AWS Content is provided subject to the terms of the AWS Customer Agreement available at http://aws.amazon.com/agreement or other written agreement between Customer and either Amazon Web Services, Inc. or Amazon Web Services EMEA SARL or both.
 */


import '@aws-amplify/ui-react/styles.css';

//import './App.css';

import {Authenticator} from '@aws-amplify/ui-react';

import Application from "./components/Application";


export default function App() {
    return (
        <Authenticator hideSignUp={true}>
            {({signOut, user}) => (
                <Application signOut={signOut}></Application>
            )}
        </Authenticator>
    );
}