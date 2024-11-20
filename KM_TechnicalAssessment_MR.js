/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/search', 'N/query'],
    
    (search, query) => {
        /**
         * Defines the function that is executed at the beginning of the map/reduce process and generates the input data.
         * @param {Object} inputContext
         * @param {boolean} inputContext.isRestarted - Indicates whether the current invocation of this function is the first
         *     invocation (if true, the current invocation is not the first invocation and this function has been restarted)
         * @param {Object} inputContext.ObjectRef - Object that references the input data
         * @typedef {Object} ObjectRef
         * @property {string|number} ObjectRef.id - Internal ID of the record instance that contains the input data
         * @property {string} ObjectRef.type - Type of the record instance that contains the input data
         * @returns {Array|Object|Search|ObjectRef|File|Query} The input data to use in the map/reduce process
         * @since 2015.2
         */

        const getInputData = (inputContext) => {

            //write a query that will get the id, sales rep, and total for each opportunity
            const queryString = `
                SELECT 
                    o.salesrep, 
                    o.totalamount, 
                    o.id, 
                    e.email, 
                    o.status
                FROM 
                    opportunity o 
                JOIN 
                    employee e 
                ON 
                    o.salesrep = e.id
                where 
                    o.status not in ('Closed Won', 'Closed Lost')
            `;
            const queryResults = query.runSuiteQL({
                query: queryString
            }).asMappedResults(); // Convert results to array of objects.
        
            log.debug('Input Data', JSON.stringify(queryResults));
            return queryResults; // Return array for Map stage.
        }

        /**
         * Defines the function that is executed when the map entry point is triggered. This entry point is triggered automatically
         * when the associated getInputData stage is complete. This function is applied to each key-value pair in the provided
         * context.
         * @param {Object} mapContext - Data collection containing the key-value pairs to process in the map stage. This parameter
         *     is provided automatically based on the results of the getInputData stage.
         * @param {Iterator} mapContext.errors - Serialized errors that were thrown during previous attempts to execute the map
         *     function on the current key-value pair
         * @param {number} mapContext.executionNo - Number of times the map function has been executed on the current key-value
         *     pair
         * @param {boolean} mapContext.isRestarted - Indicates whether the current invocation of this function is the first
         *     invocation (if true, the current invocation is not the first invocation and this function has been restarted)
         * @param {string} mapContext.key - Key to be processed during the map stage
         * @param {string} mapContext.value - Value to be processed during the map stage
         * @since 2015.2
         */

        // 30 governance units possible

        const map = (mapContext) => {
            const opportunityInfo = JSON.parse(mapContext.value); // Parse the value passed from getInputData.

            log.debug('Map Input', opportunityInfo);
        
            if (opportunityInfo.totalamount < 10000 && opportunityInfo.status === 'Open') {
                // Automatically approve
                record.submitFields({ //governance unit 10
                    type: record.Type.OPPORTUNITY,
                    id: opportunityInfo.id,
                    values: { status: 'Approved' }
                });
            
                // Transform Opportunity into Sales Order
                try {
                    const salesOrder = record.transform({ //governance unit 10
                        fromType: record.Type.OPPORTUNITY,
                        fromId: opportunityInfo.id,
                        toType: record.Type.SALES_ORDER,
                    });

                    let salesOrderTranId = salesOrder.getValue('tranid');

                    opportunityInfo.salesorder = salesOrderTranId;
            
                    let salesOrderId = salesOrder.save();
                    mapContext.write(opportunityInfo.salesrep, JSON.stringify(opportunityInfo));
            
                } catch (error) {
                    log.error('Sales Order Transformation Error', JSON.stringify(error));
                }
            } else if (opportunityInfo.status === 'Open' && opportunityInfo.totalamount >= 10000) {
                // Flag for manual approval
                record.submitFields({
                    type: record.Type.OPPORTUNITY,
                    id: opportunityInfo.id,
                    values: { needsmanualapproval: true }
                });
            }

            if(opportunityInfo.status == 'Approved'){
                // Transform Opportunity into Sales Order
                try {
                    const salesOrder = record.transform({ //governance unit 10
                        fromType: record.Type.OPPORTUNITY,
                        fromId: opportunityInfo.id,
                        toType: record.Type.SALES_ORDER,
                    });

                    let salesOrderTranId = salesOrder.getValue('tranid');

                    opportunityInfo.salesorder = salesOrderTranId;
            
                    let salesOrderId = salesOrder.save();
                    mapContext.write(opportunityInfo.salesrep, JSON.stringify(opportunityInfo));
            
                } catch (error) {
                    log.error('Sales Order Transformation Error', JSON.stringify(error));
                }
            }
        }

        /**
         * Defines the function that is executed when the reduce entry point is triggered. This entry point is triggered
         * automatically when the associated map stage is complete. This function is applied to each group in the provided context.
         * @param {Object} reduceContext - Data collection containing the groups to process in the reduce stage. This parameter is
         *     provided automatically based on the results of the map stage.
         * @param {Iterator} reduceContext.errors - Serialized errors that were thrown during previous attempts to execute the
         *     reduce function on the current group
         * @param {number} reduceContext.executionNo - Number of times the reduce function has been executed on the current group
         * @param {boolean} reduceContext.isRestarted - Indicates whether the current invocation of this function is the first
         *     invocation (if true, the current invocation is not the first invocation and this function has been restarted)
         * @param {string} reduceContext.key - Key to be processed during the reduce stage
         * @param {List<String>} reduceContext.values - All values associated with a unique key that was passed to the reduce stage
         *     for processing
         * @since 2015.2
         */

        // if there is 20 sales reps, the reduce function will be called 20 times
        // 20 X 20 = 400 governance units
        const reduce = (reduceContext) => {
            const salesRep = reduceContext.key; // Sales Rep's email from Map stage.
            const opportunityInfo = reduceContext.values

            const emailBody = `
                The following Sales Orders have been created:
                ${opportunityInfo.map(opportunity => opportunity.salesorder).join('\n')}
            `;

            try {
                email.send({
                    author: -1, // Default system user
                    recipients: [opportunityInfo[0].email],
                    subject: 'Sales Orders Created',
                    body: emailBody
                });
            } catch (error) {
                log.error('Email Error', `Failed to send email to ${salesRep}: ${error}`);
            }
        }


        /**
         * Defines the function that is executed when the summarize entry point is triggered. This entry point is triggered
         * automatically when the associated reduce stage is complete. This function is applied to the entire result set.
         * @param {Object} summaryContext - Statistics about the execution of a map/reduce script
         * @param {number} summaryContext.concurrency - Maximum concurrency number when executing parallel tasks for the map/reduce
         *     script
         * @param {Date} summaryContext.dateCreated - The date and time when the map/reduce script began running
         * @param {boolean} summaryContext.isRestarted - Indicates whether the current invocation of this function is the first
         *     invocation (if true, the current invocation is not the first invocation and this function has been restarted)
         * @param {Iterator} summaryContext.output - Serialized keys and values that were saved as output during the reduce stage
         * @param {number} summaryContext.seconds - Total seconds elapsed when running the map/reduce script
         * @param {number} summaryContext.usage - Total number of governance usage units consumed when running the map/reduce
         *     script
         * @param {number} summaryContext.yields - Total number of yields when running the map/reduce script
         * @param {Object} summaryContext.inputSummary - Statistics about the input stage
         * @param {Object} summaryContext.mapSummary - Statistics about the map stage
         * @param {Object} summaryContext.reduceSummary - Statistics about the reduce stage
         * @since 2015.2
         */
        const summarize = (summaryContext) => {
            log.audit('Input Summary', JSON.stringify(summaryContext.inputSummary));
            log.audit('Map Summary', JSON.stringify(summaryContext.mapSummary));
            log.audit('Reduce Summary', JSON.stringify(summaryContext.reduceSummary));
        
            summaryContext.output.iterator().each((key, value) => {
                log.audit(`Summarize Output`, `Key: ${key}, Value: ${value}`);
                return true;
            });
        
            summaryContext.mapSummary.errors.iterator().each((key, error) => {
                log.error(`Map Error for Key: ${key}`, `Error: ${error}`);
                return true;
            });
        
            summaryContext.reduceSummary.errors.iterator().each((key, error) => {
                log.error(`Reduce Error for Key: ${key}`, `Error: ${error}`);
                return true;
            });
        };

        return {getInputData, map, reduce, summarize}

    });
