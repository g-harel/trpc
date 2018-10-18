import express from "express";

import {Sender, SenderResponse} from "./link";

// prettier-ignore
export type Method = "GET" | "HEAD" | "POST" | "PUT" | "DELETE" | "CONNECT" | "OPTIONS" | "TRACE" | "PATCH";

// prettier-ignore
export type Status = 100 | 101 | 102 | 103 | 200 | 201 | 202 | 203 | 204 | 205 | 206 | 207 | 208 | 226 | 300 | 301 | 302 | 303 | 304 | 305 |  306 | 307 | 308 | 400 | 401 | 402 | 403 | 404 | 405 | 406 | 407 | 408 | 409 | 410 | 411 | 412 | 413 | 414 | 415 | 416 | 417 | 418 | 421 |  422 | 423 | 424 | 426 | 428 | 429 | 431 | 451 | 500 | 501 | 502 | 503 | 504 | 505 | 506 | 507 | 508 | 510 | 511;

// Config object influences the behavior of both the
// request making and handling logic. It is designed to
// make it possible to represent an arbitrary endpoint
// that is not necessarily managed by this package.
export interface Config {
    // HTTP method used when handling and making requests.
    // Defaults to "POST" if not configured.
    method?: Method;

    // The base should contain everything in the url before
    // the path. Default value of "" will send requests to the
    // same domain.
    base?: string;

    // URL path at which the handler will be registered and
    // the requests will be sent. This setting is required.
    path: string;

    // Expected returned status code(s). By default, anything
    // but a "200" is considered an error. This value is only
    // used for making requests and has no influence on the
    // handler which will also return "200" by default.
    expect?: Status | Status[];
}

// Headers passed when invoking an endpoint.
export interface Headers {
    [name: string]: string;
}

// A stricter version of the Config which demands defined values.
export interface StrictConfig {
    method: Method;
    base: string;
    path: string;
    expect: Status[];
}

// Request handlers contain the server code that transforms
// typed requests into typed responses. Both express' request
// and response objects are passed to the function to make it
// possible to implement custom behavior like accessing and
// writing headers when necessary.
export interface RequestHandler<RQ, RS> {
    (data: RQ, req: express.Request, res: express.Response): Promise<RS> | RS;
}

// An endpoint contains its configuration as well as the types
// of the request and response values.
export class Endpoint<RQ, RS> {
    // Sender is invoked with an object representing an http
    // request. Its only responsibility is to return a similarly
    // structured response object. It is private/static to be
    // a hidden global that can still be manipulated by `./link`.
    private static sender: Sender = async (request) => {
        const response = await fetch(request.url, {
            method: request.method,
            headers: request.headers,
            body: request.body,
            credentials: "same-origin",
        });

        const body = await response.text();
        const status = response.status as Status;
        return {body, status};
    };

    private config: StrictConfig;

    constructor(pathOrConfig: Config | string) {
        // After this block, the input argument can only have
        // the type of a Config.
        if (typeof pathOrConfig === "string") {
            pathOrConfig = {path: pathOrConfig};
        }

        this.config = {
            path: pathOrConfig.path || "/",
            base: pathOrConfig.base || "",
            method: pathOrConfig.method || "POST",
            // The expected status is normalized into an array.
            expect: [].concat(pathOrConfig.expect || (200 as any)) as Status[],
        };
    }

    // Helper to throw formatted errors with added information
    // about the endpoint instance.
    private error(...messages: any[]): Error {
        const {method, base, path} = this.config;
        messages.unshift(`EndpointError (${method} ${base}${path})`);
        messages = messages.map((message, i) => {
            return " ".repeat(i) + message.toString();
        });
        const e = new Error(messages.join("\n"));
        return e;
    }

    // The call function sends requests to the configured
    // endpoint using the configured sender function.
    // It returns a promise which may throw errors if there
    // is an issue with the request process or if the status
    // is unexpected.
    public async call(requestData: RQ, ...h: Headers[]): Promise<RS> {
        let body: string;
        try {
            body = JSON.stringify(requestData);
        } catch (e) {
            throw this.error("Could not stringify request data", e);
        }

        const url = `${this.config.base}${this.config.path}`;
        const method = this.config.method;
        const headers: Headers = Object.assign(
            {
                "Content-Type": "application/json",
            },
            ...h,
        );

        let res: SenderResponse;
        try {
            res = await Endpoint.sender({method, url, body, headers});
        } catch (e) {
            throw this.error("Request sending failed", e);
        }
        if ((this.config.expect as any).indexOf(res.status as any) < 0) {
            throw this.error(`Unexpected status: ${res.status}`, res.body);
        }

        let responseData: RS;
        try {
            responseData = JSON.parse(res.body);
        } catch (e) {
            throw this.error("Could not parse response data", e, res.body);
        }
        return responseData;
    }

    // Handler generator returning an express request handler
    // from a config and a request handling function.
    public handler(handler: RequestHandler<RQ, RS>): express.RequestHandler {
        return async (req, res, next) => {
            // Only requests with the correct path and method are handled.
            if (req.path !== this.config.path) {
                return next();
            }
            if (req.method !== this.config.method) {
                return next();
            }

            // Handler is not invoked if a different handler
            // has already answered the request. This situation
            // is considered an error since the handler should
            // have been used.
            if (res.headersSent) {
                return next(this.error("Response has already been sent."));
            }

            // Request body is streamed into a string to be parsed.
            const rawRequestData = await new Promise<string>((resolve) => {
                let data = "";
                req.setEncoding("utf8");
                req.on("data", (chunk) => (data += chunk));
                req.on("end", () => resolve(data));
            });

            let requestData: RQ;
            try {
                requestData = JSON.parse(rawRequestData);
            } catch (e) {
                return next(
                    this.error("Could not parse request data", e, rawRequestData),
                );
            }

            let responseData: RS;
            try {
                responseData = await handler(requestData, req, res);
            } catch (e) {
                return next(this.error("Handler error", e));
            }

            // Although the handler is given access to the express
            // response object, it should not send the data itself.
            if (res.headersSent) {
                return next(this.error("Response was sent by handler."));
            }

            let rawResponseData: string = "";
            try {
                rawResponseData = JSON.stringify(responseData);
            } catch (e) {
                return this.error("Could not stringify response data", e);
            }

            res.status(200);
            res.set("Content-Type", "application/json");
            res.send(rawResponseData);
        };
    }
}
