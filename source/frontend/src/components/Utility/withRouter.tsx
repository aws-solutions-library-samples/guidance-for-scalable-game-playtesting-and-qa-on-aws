import { useNavigate } from "react-router-dom";

// Higher-Order Component to inject `navigate` into props
export function withRouter(Component: any) {
    return function WithRouter(props: any) {
        const navigate = useNavigate();
        return <Component {...props} navigate={navigate} />;
    };
}
